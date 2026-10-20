// pocket-transcribe — streaming speech to text for the console agent, on the
// Mac's own speech model (macOS 26 SpeechAnalyzer + SpeechTranscriber).
//
//   pocket-transcribe <sample rate> [locale]
//
// stdin   s16le mono PCM at <sample rate>, until EOF
// stdout  one JSON object per line: {"text": "...", "final": false} while the
//         speech is recognized (the whole text so far, volatile tail
//         included), then {"text": "...", "final": true} once after EOF
// stderr  diagnostics; exit status 1 on a failure, after a final line with
//         {"error": "..."}
//
// The locale defaults to the Mac's first preferred language. The model for a
// locale downloads on first use; nothing leaves the Mac after that.

import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  emit(["error": message, "final": true, "text": ""])
  FileHandle.standardError.write("pocket-transcribe: \(message)\n".data(using: .utf8)!)
  exit(1)
}

@main
struct Transcribe {
  static func main() async {
    let arguments = CommandLine.arguments
    guard arguments.count >= 2, let rate = Double(arguments[1]), rate >= 8000, rate <= 48000 else {
      fail("usage: pocket-transcribe <sample rate> [locale]")
    }
    guard #available(macOS 26.0, *) else { fail("speech recognition needs macOS 26") }
    let wanted = Locale(identifier: arguments.count >= 3 ? arguments[2] : (Locale.preferredLanguages.first ?? "en-US"))
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
      fail("no speech model for \(wanted.identifier)")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        FileHandle.standardError.write("pocket-transcribe: installing the \(locale.identifier) speech model if missing\n".data(using: .utf8)!)
        try await request.downloadAndInstall()
      }
    } catch {
      fail("model download failed: \(error.localizedDescription)")
    }
    guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      fail("no audio format for the speech model")
    }
    guard let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true),
          let converter = AVAudioConverter(from: source, to: target) else {
      fail("cannot convert \(rate) Hz PCM to \(target)")
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let (inputs, feed) = AsyncStream<AnalyzerInput>.makeStream()

    // Results: committed text plus the volatile tail, reported whole.
    let reporter = Task { () -> String in
      var committed = ""
      do {
        for try await result in transcriber.results {
          let text = String(result.text.characters)
          if result.isFinal {
            committed += text
            emit(["text": committed, "final": false])
          } else {
            emit(["text": committed + text, "final": false])
          }
        }
      } catch {
        FileHandle.standardError.write("pocket-transcribe: \(error.localizedDescription)\n".data(using: .utf8)!)
      }
      return committed
    }

    do {
      try await analyzer.start(inputSequence: inputs)
    } catch {
      fail("analyzer failed to start: \(error.localizedDescription)")
    }

    // stdin -> converted buffers. A read returns what the pipe holds, so an
    // odd byte waits for its partner in the next read.
    let reader = Task.detached { () -> Void in
      var carry = Data()
      while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { break }
        carry.append(chunk)
        let frames = carry.count / 2
        if frames == 0 { continue }
        let bytes = frames * 2
        guard let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(frames)) else { continue }
        input.frameLength = AVAudioFrameCount(frames)
        _ = carry.withUnsafeBytes { raw in
          memcpy(input.int16ChannelData![0], raw.baseAddress!, bytes)
        }
        carry.removeFirst(bytes)
        let capacity = AVAudioFrameCount(Double(frames) * target.sampleRate / rate) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { continue }
        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
          if consumed {
            status.pointee = .noDataNow
            return nil
          }
          consumed = true
          status.pointee = .haveData
          return input
        }
        if let error {
          FileHandle.standardError.write("pocket-transcribe: convert: \(error.localizedDescription)\n".data(using: .utf8)!)
          continue
        }
        if output.frameLength > 0 { feed.yield(AnalyzerInput(buffer: output)) }
      }
      feed.finish()
    }
    await reader.value
    do {
      try await analyzer.finalizeAndFinishThroughEndOfInput()
    } catch {
      fail("analyzer failed: \(error.localizedDescription)")
    }
    let text = await reporter.value
    emit(["text": text, "final": true])
    exit(0)
  }
}
