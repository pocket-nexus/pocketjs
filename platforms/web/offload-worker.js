// Nonwaiting host adapter. Credits bound both posted work and retained replies.
// A failed worker drops its generation; reconnect requires a fresh worker.
export function createWorkerOffload({ workerUrl, wasmUrl, pak }) {
  const worker = new Worker(workerUrl, { type: "module" });
  const replies = [];
  let generation = 0,
    credits = 0,
    delivered = false,
    closed = false;
  const fail = () => {
    generation = 0;
    replies.length = 0;
    credits = 0;
    worker.terminate();
  };
  worker.onerror = fail;
  worker.onmessage = ({ data }) => {
    if (closed) return;
    if (data.ready) {
      generation = 1;
      return;
    }
    if (
      generation <= 0 ||
      typeof data.record !== "string" ||
      data.record.length > 4096 ||
      replies.length >= 8
    ) {
      fail();
      return;
    }
    replies.push(data.record);
  };
  worker.postMessage({ init: true, wasmUrl: String(wasmUrl), pak });
  return {
    ops: {
      session: () => generation,
      submit(record) {
        if (
          !generation ||
          credits >= 8 ||
          typeof record !== "string" ||
          record.length > 4096
        )
          return false;
        credits++;
        worker.postMessage({ record });
        return true;
      },
      take() {
        if (delivered || !replies.length) return undefined;
        delivered = true;
        credits--;
        return replies.shift();
      },
    },
    beginFrame() {
      delivered = false;
    },
    dispose() {
      closed = true;
      fail();
    },
  };
}
