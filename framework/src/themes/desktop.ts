// Semantic desktop chrome. Applications own content and behavior; these
// complete class literals keep all XP paint inside the theme boundary.
export interface DesktopTheme {
  window: string; caption: string; title: string; close: string; closeText: string;
  body: string; text: string; muted: string; heading: string;
  tabs: string; tab(selected: boolean): string; tabText(selected: boolean): string;
  button: string; primaryButton: string; disabledButton: string; buttonText: string;
  group: string; groupTitle: string; well: string; status: string;
  progressTrack: string; progressFill: string; success: string; failure: string;
  check(checked: boolean): string; separator: string;
}

/** Original geometric chrome inspired by the XP Luna blue palette. Uses the
 * framework's bundled fonts; no desktop-shell assets or system fonts. */
export const XP_THEME: DesktopTheme = {
  // Keep child fills inside the frame: 7px outer radius minus 3px inset = 4px.
  window: "absolute flex-col p-[3] rounded-[7] border-[#174bb8] border-[2] bg-[#265ac9] shadow-lg overflow-hidden",
  caption: "h-[32] flex-row items-center px-[8] gap-[7] rounded-[4] bg-gradient-to-b from-[#6ba4ff] via-[#2869df] to-[#1551c2]",
  title: "text-sm font-bold text-white",
  close: "w-[23] h-[23] items-center justify-center rounded-[4] border border-white bg-gradient-to-b from-[#f59a7b] to-[#c63317] focus:bg-[#e86642] active:bg-[#ac301c]",
  closeText: "text-sm font-bold text-white",
  body: "flex-1 flex-col p-[12] gap-[10] bg-[#ece9d8]",
  text: "text-xs text-[#202020]",
  muted: "text-xs text-[#5d5d53]",
  heading: "text-sm font-bold text-[#214795]",
  tabs: "h-[30] flex-row items-center gap-[3] bg-[#ece9d8]",
  tab: selected => selected
    ? "flex-1 h-[30] items-center justify-center rounded-[4] border border-[#8e9298] bg-[#fcfcf8]"
    : "flex-1 h-[30] items-center justify-center rounded-[4] border border-[#9c9e98] bg-gradient-to-b from-[#f8f7f1] to-[#dfdfd4] focus:bg-[#fff4cd] active:bg-[#dddccf]",
  tabText: selected => selected ? "text-xs font-bold text-[#184699]" : "text-xs text-[#3c3c38]",
  button: "h-[30] flex-1 items-center justify-center rounded-[3] border border-[#7d887d] bg-gradient-to-b from-[#ffffff] via-[#f5f3e9] to-[#e0decf] focus:border-[#d29a2e] active:bg-[#d0cec1]",
  primaryButton: "h-[30] items-center justify-center rounded-[3] border-[#316ac5] border-[2] bg-gradient-to-b from-[#ffffff] to-[#e3ebfb] focus:border-[#dd9c29] active:bg-[#c4d4ed]",
  disabledButton: "h-[30] flex-1 items-center justify-center rounded-[3] border border-[#b9b8af] bg-[#e8e6da] opacity-50",
  buttonText: "text-xs text-[#1c2b42]",
  group: "relative flex-col gap-[7] p-[9] border border-[#b9b8a8] rounded-[4]",
  groupTitle: "text-xs font-bold text-[#315697]",
  well: "flex-col p-[8] gap-[4] border border-[#9c9c88] bg-[#fffffb]",
  status: "h-[25] px-[8] flex-row items-center rounded-[4] border border-[#aaa99e] bg-[#e2dfcf]",
  progressTrack: "h-[13] border border-[#849081] bg-[#fffffd] rounded-[2] overflow-hidden",
  progressFill: "h-full bg-gradient-to-b from-[#a2dd72] via-[#6db742] to-[#459329]",
  success: "text-xs font-bold text-[#277223]",
  failure: "text-xs font-bold text-[#a52a20]",
  check: checked => checked
    ? "w-[14] h-[14] border border-[#507047] bg-gradient-to-b from-[#fbfff5] to-[#b4d49f]"
    : "w-[14] h-[14] border border-[#859078] bg-white",
  separator: "h-[1] bg-[#bab9aa]",
};
