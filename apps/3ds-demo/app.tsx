// apps/3ds-demo/app.tsx — dual-output acceptance demo for the Nintendo 3DS (the 3ds-runtime host contract).
//
// Two screens split one classic iPhone app. The auxiliary display holds the
// Contacts list — a 10,000-row VirtualList whose viewport mounts only the
// visible window plus overscan, while touch drag/fling changes the canvas
// transform without laying out all rows. The primary display holds the detail
// card the phone had to push a whole screen to reach: tap a row and the card
// changes, and it stays put while the list scrubs away underneath it. That
// cross-surface flow is what the two outputs are for, and it exercises the
// host the old diagnostic panel only described: two independent DrawLists, a
// baked image, and touch that arrives on the auxiliary surface alone.
//
// The circle pad scrolls the list through the VirtualList's own d-pad
// binding, which reads `analogY()` — no app code needed, which is why nothing
// here samples the pad.
//
// The auxiliary screen is 320 px wide — the classic iPhone width — but its
// 3.02" panel runs ~133 ppi against the phone's ~165, so copying the phone's
// pixel metrics 1:1 would draw everything a fifth larger than the phone drew
// it. The contact list scales them by 0.82 instead, which is the same
// PHYSICAL size and fits 5 rows on a 240 px screen: a 36 px navigation bar, a
// 36 px search field that scrolls away as the table header, 36 px contact
// rows at 16 px, and 18 px section headers that stick to the top of the table
// until the next one pushes them off.

import { createMemo, createSignal } from "solid-js";
import {
  AuxiliarySurface,
  Image,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { VirtualList } from "@pocketjs/framework/virtual-list";

const LIST_ROWS = 10_000;

// Classic iPhone table metrics at 0.82. SLOT is the section-header height and
// the VirtualList's uniform unit; a contact row and the search header each
// span two slots, which is how an 18 px header and a 36 px row share one list.
const SLOT = 18;
const ROW_SLOTS = 2;
const SEARCH_SLOTS = 2;
const ROW_HEIGHT = SLOT * ROW_SLOTS;
const SEARCH_HEIGHT = SLOT * SEARCH_SLOTS;
const NAV_HEIGHT = 36;
const LIST_TOP = NAV_HEIGHT;
const LIST_HEIGHT = 240 - LIST_TOP;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GIVEN_NAMES = [
  "Avery",
  "Chloe",
  "Elliot",
  "Harper",
  "Jamie",
  "Morgan",
  "Riley",
  "Taylor",
] as const;
const SURNAMES = [
  "Adams",
  "Bennett",
  "Carter",
  "Dawson",
  "Ellis",
  "Foster",
  "Garcia",
  "Hayes",
  "Irwin",
  "Jordan",
  "Keller",
  "Lewis",
  "Morris",
  "Nelson",
  "Owens",
  "Parker",
  "Quinn",
  "Reed",
  "Sullivan",
  "Turner",
  "Underwood",
  "Vaughn",
  "Walker",
  "Xavier",
  "Young",
  "Zimmerman",
] as const;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

interface ContactSection {
  letter: string;
  surname: string;
  contactStart: number;
  contactCount: number;
  /** Slot holding this section's 18 px header; contacts follow, two slots each. */
  slotStart: number;
}

const CONTACT_SECTIONS: readonly ContactSection[] = (() => {
  let contactStart = 0;
  let slotStart = SEARCH_SLOTS;
  return SURNAMES.map((surname, index) => {
    const contactCount = Math.floor(LIST_ROWS / LETTERS.length) +
      (index < LIST_ROWS % LETTERS.length ? 1 : 0);
    const section = {
      letter: LETTERS[index],
      surname,
      contactStart,
      contactCount,
      slotStart,
    };
    contactStart += contactCount;
    slotStart += 1 + contactCount * ROW_SLOTS;
    return section;
  });
})();

const LIST_SLOTS = SEARCH_SLOTS + LIST_ROWS * ROW_SLOTS + CONTACT_SECTIONS.length;
const MAX_SCROLL = LIST_SLOTS * SLOT - LIST_HEIGHT;

// A-Z index. 26 entries never fit 204 px at a readable size, so the strip
// drops letters the way UITableView does and marks each gap with a dot. The
// touch mapping stays continuous over all 26 sections.
const INDEX_PITCH = 12;
const INDEX_ENTRIES = (() => {
  const fits = Math.floor((LIST_HEIGHT - 8) / INDEX_PITCH);
  const count = fits % 2 === 1 ? fits : fits - 1; // start and end on a letter
  const letters = (count + 1) / 2;
  return Array.from({ length: count }, (_, entry) =>
    entry % 2 === 0
      ? LETTERS[Math.round((entry / 2) * (LETTERS.length - 1) / (letters - 1))]
      : null,
  );
})();
const INDEX_PAD = (LIST_HEIGHT - INDEX_ENTRIES.length * INDEX_PITCH) / 2;

function sectionForSlot(slot: number): number {
  const bounded = Math.max(0, Math.min(LIST_SLOTS - 1, slot));
  for (let index = CONTACT_SECTIONS.length - 1; index >= 0; index--) {
    if (bounded >= CONTACT_SECTIONS[index].slotStart) return index;
  }
  return 0;
}

/** The 18 px gradient bar carrying a section letter — in the table and pinned. */
function SectionHeader(letter: () => string, debugName: string) {
  return (
    <View
      debugName={debugName}
      class="relative w-full h-[18] bg-gradient-to-b from-[#b7bec8] to-[#949ca8]"
    >
      <View class="absolute left-0 right-0 top-0 h-[1] bg-[#d2d7de]" />
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#7b838e]" />
      <Text class="absolute left-[8] top-[1] text-sm text-[#71798599] font-bold">{letter()}</Text>
      <Text class="absolute left-[8] top-0 text-sm text-white font-bold">{letter()}</Text>
    </View>
  );
}

function SearchHeader() {
  return (
    <View
      debugName="ContactsSearch"
      class="relative w-full h-[36] bg-gradient-to-b from-[#cbcfd4] to-[#a6acb4]"
    >
      <View class="absolute left-0 right-0 top-0 h-[1] bg-[#e4e7ea]" />
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#888e97]" />
      <View class="absolute left-[6] top-[6] right-[20] h-[24] flex-row items-center pl-[7] gap-[4] rounded-[12] bg-white border border-[#9aa0a8]">
        <View class="relative w-[9] h-[9]">
          <View class="absolute left-0 top-0 w-[7] h-[7] rounded-full border border-[#8b9199]" />
          <View
            class="absolute left-[5] top-[7] w-[4] h-[1] bg-[#8b9199]"
            style={{ rotate: 45 }}
          />
        </View>
        <Text class="text-sm text-[#8b9199]">Search</Text>
      </View>
    </View>
  );
}

/** Contact index a slot renders, or -1 for the search header, a section
 *  header, or a contact row's second slot. */
function contactAtSlot(slot: number): number {
  if (slot < SEARCH_SLOTS || slot >= LIST_SLOTS) return -1;
  const section = CONTACT_SECTIONS[sectionForSlot(slot)];
  if (slot === section.slotStart) return -1;
  const withinSection = slot - section.slotStart - 1;
  return withinSection % ROW_SLOTS === 0
    ? section.contactStart + withinSection / ROW_SLOTS
    : -1;
}

function givenNameFor(contactIndex: number, sectionIndex: number): string {
  return GIVEN_NAMES[(contactIndex * 5 + sectionIndex) % GIVEN_NAMES.length];
}

function ContactRow(contactIndex: number, sectionIndex: number, selected: () => boolean) {
  const section = CONTACT_SECTIONS[sectionIndex];
  const ordinal = String(contactIndex + 1).padStart(5, "0");
  const given = givenNameFor(contactIndex, sectionIndex);
  return (
    <View
      debugName={`VirtualContact${ordinal}`}
      class={
        selected()
          ? "absolute left-0 right-0 top-0 h-[36] flex-row items-center pl-[8] pb-[4] gap-[4] bg-gradient-to-b from-[#4c9bf5] to-[#0a63dd]"
          : "absolute left-0 right-0 top-0 h-[36] flex-row items-center pl-[8] pb-[4] gap-[4] bg-white"
      }
    >
      <Text class={selected() ? "text-base text-white" : "text-base text-black"}>{given}</Text>
      <Text class={selected() ? "text-base text-white font-bold" : "text-base text-black font-bold"}>
        {section.surname}
      </Text>
      <View
        class={
          selected()
            ? "absolute left-0 right-0 bottom-0 h-[1] bg-[#0a55c4]"
            : "absolute left-0 right-0 bottom-0 h-[1] bg-[#d0d0d3]"
        }
      />
    </View>
  );
}

/** One grouped-cell field: bold label right-aligned in the gutter, value after. */
function Field(label: string, value: () => string, link: boolean) {
  return (
    <View class="flex-row items-center w-full h-[32] pb-[3] gap-[8]">
      <Text class="w-[58] text-right text-xs text-[#55677d] font-bold">{label}</Text>
      <Text class={link ? "text-sm text-[#1b4fa8]" : "text-sm text-[#15181c]"}>{value()}</Text>
    </View>
  );
}

export default function ThreeDsDemo() {
  const [indexing, setIndexing] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  let contactIndexNode: NodeMirror | undefined;

  // The card on the primary display. Every field is a pure function of the
  // contact index, so a 10,000-record directory needs no stored rows.
  const card = createMemo(() => {
    const index = Math.max(0, Math.min(LIST_ROWS - 1, selected()));
    let sectionIndex = 0;
    for (let i = CONTACT_SECTIONS.length - 1; i >= 0; i--) {
      if (index >= CONTACT_SECTIONS[i].contactStart) {
        sectionIndex = i;
        break;
      }
    }
    const surname = CONTACT_SECTIONS[sectionIndex].surname;
    const given = givenNameFor(index, sectionIndex);
    // 555-0100..555-0199 is the range reserved for fictional numbers.
    const line = (salt: number) => `555-01${String((index * salt + salt) % 100).padStart(2, "0")}`;
    return {
      given,
      surname,
      ordinal: String(index + 1).padStart(5, "0"),
      mobile: `(415) ${line(7)}`,
      home: `(415) ${line(13)}`,
      work: `(212) ${line(29)}`,
      email: `${given}@${surname}.com`.toLowerCase(),
      birthday:
        `${MONTHS[(index * 5 + 2) % 12]} ${1 + (index * 7) % 28}, 19${58 + (index * 3) % 40}`,
    };
  });

  /** A tap anywhere on a contact's 36 px row selects it — the row's second
   *  18 px slot is an empty view that claims the hit for the row above it. */
  const selectSlot = (slot: number) => {
    const direct = contactAtSlot(slot);
    const index = direct >= 0 ? direct : contactAtSlot(slot - 1);
    if (index >= 0) setSelected(index);
  };

  const renderSlot = (slot: number) => {
    if (slot < SEARCH_SLOTS) return slot === 0 ? SearchHeader() : null;
    const sectionIndex = sectionForSlot(slot);
    const section = CONTACT_SECTIONS[sectionIndex];
    if (slot === section.slotStart) {
      return SectionHeader(() => section.letter, `ContactSection${section.letter}`);
    }
    const contactIndex = contactAtSlot(slot);
    if (contactIndex < 0) return null; // the row's second slot
    return ContactRow(contactIndex, sectionIndex, () => selected() === contactIndex);
  };

  const listScroller = createScroller({
    max: () => MAX_SCROLL,
    extent: () => LIST_HEIGHT,
  });

  // The section header of the row at the top of the table stays pinned there
  // until the next section's header reaches it and pushes it off.
  const pinnedSection = () => {
    const offset = listScroller.offset();
    if (offset < SEARCH_HEIGHT) return -1;
    return sectionForSlot(Math.floor(offset / SLOT));
  };
  const pinnedLetter = () => {
    const index = pinnedSection();
    return index < 0 ? "" : CONTACT_SECTIONS[index].letter;
  };
  const pinnedShift = () => {
    const index = pinnedSection();
    if (index < 0 || index >= CONTACT_SECTIONS.length - 1) return 0;
    const nextTop = CONTACT_SECTIONS[index + 1].slotStart * SLOT - listScroller.offset();
    return nextTop < SLOT ? nextTop - SLOT : 0;
  };

  const sectionIndexForY = (y: number) => {
    const fraction = Math.max(0, Math.min(0.999999, (y - LIST_TOP) / LIST_HEIGHT));
    return Math.floor(fraction * CONTACT_SECTIONS.length);
  };
  const jumpToSection = (y: number) => {
    const section = CONTACT_SECTIONS[sectionIndexForY(y)];
    listScroller.scrollTo(section.slotStart * SLOT, { immediate: true });
  };

  createGesture({
    surface: "auxiliary",
    region: { node: () => contactIndexNode },
    axis: "y",
    panSlop: 1,
    onDown: (contact) => {
      setIndexing(true);
      listScroller.stop();
      jumpToSection(contact.y);
    },
    onPanMove: (contact) => jumpToSection(contact.y),
    onUp: () => setIndexing(false),
    onCancel: () => setIndexing(false),
  });

  return (
    <>
      {/* Primary display: the detail card the phone reached by pushing a
          screen. 400x240 at the same ~133 ppi as the touch screen, so it
          keeps the auxiliary screen's 0.82 metrics — 16 px status bar, 36 px
          navigation bar, 32 px grouped-cell fields. */}
      <View debugName="ThreeDsScreen" class="relative w-full h-full bg-[#c5ccd3] overflow-hidden">
        <View debugName="StatusBar" class="absolute left-0 right-0 top-0 h-[16] bg-gradient-to-b from-[#cbcfd4] to-[#8f959c]">
          <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#6d737a]" />
          <View class="absolute left-[6] top-[10] w-[3] h-[3] bg-[#23272c]" />
          <View class="absolute left-[10] top-[8] w-[3] h-[5] bg-[#23272c]" />
          <View class="absolute left-[14] top-[6] w-[3] h-[7] bg-[#23272c]" />
          <View class="absolute left-[18] top-[4] w-[3] h-[9] bg-[#23272c]" />
          <View class="absolute left-[22] top-[2] w-[3] h-[11] bg-[#23272c40]" />
          <Text class="absolute left-[31] top-0 text-xs text-[#23272c]">PocketJS</Text>
          <Text class="absolute left-0 right-0 top-0 text-center text-xs text-[#23272c] font-bold">9:41 AM</Text>
          <View class="absolute left-[368] top-[4] w-[20] h-[9] rounded-[2] border border-[#23272c]" />
          <View class="absolute left-[370] top-[6] w-[16] h-[5] bg-[#23272c]" />
          <View class="absolute left-[389] top-[6] w-[2] h-[5] bg-[#23272c]" />
        </View>

        <View debugName="CardNavigation" class="absolute left-0 right-0 top-[16] h-[36] bg-[#6d7e99]">
          <View class="absolute left-0 right-0 top-0 h-[18] bg-gradient-to-b from-[#b2becf] to-[#8d9cb4]" />
          <View class="absolute left-0 right-0 top-[18] h-[18] bg-gradient-to-b from-[#7d8ea8] to-[#66778f]" />
          <View class="absolute left-0 right-0 top-0 h-[1] bg-[#ccd4df]" />
          <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />

          <Text class="absolute left-[62] right-[62] top-[7] text-center text-base text-[#3c4d6480] font-bold">Info</Text>
          <Text class="absolute left-[62] right-[62] top-[8] text-center text-base text-white font-bold">Info</Text>

          <View class="absolute right-[4] top-[6] w-[44] h-[24] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]">
            <View class="absolute left-[2] right-[2] top-[1] h-[1] bg-[#c8d1de80]" />
            <Text class="absolute left-0 right-0 top-[3] text-center text-xs text-[#39495f80] font-bold">Edit</Text>
            <Text class="absolute left-0 right-0 top-[4] text-center text-xs text-white font-bold">Edit</Text>
          </View>
        </View>

        <View debugName="CardIdentity" class="absolute left-[14] top-[60] w-[130]">
          <View class="w-[70] h-[70] p-[3] rounded-[4] bg-white border border-[#8f959d] shadow">
            <Image debugName="ContactPhoto" class="w-[64] h-[64]" src="contact-photo.svg" />
          </View>
          <Text class="absolute left-0 top-[78] text-sm text-[#3b4149]">{card().given}</Text>
          <Text class="absolute left-0 top-[96] text-lg text-[#14181d] font-bold">{card().surname}</Text>
          <Text class="absolute left-0 top-[126] text-xs text-[#6a727b]">
            Record {card().ordinal} of 10,000
          </Text>
        </View>

        <View class="absolute left-[14] top-[205] w-[130] h-[26] items-center justify-center rounded-[8] bg-white border border-[#a4abb3]">
          <Text class="text-sm text-[#1b4fa8] font-bold">Share Contact</Text>
        </View>

        <View debugName="CardPhones" class="absolute left-[154] top-[60] w-[232] h-[98] flex-col rounded-[8] bg-white border border-[#a4abb3] overflow-hidden">
          {Field("mobile", () => card().mobile, false)}
          <View class="w-full h-[1] bg-[#c9ced4]" />
          {Field("home", () => card().home, false)}
          <View class="w-full h-[1] bg-[#c9ced4]" />
          {Field("work", () => card().work, false)}
        </View>

        <View debugName="CardDetails" class="absolute left-[154] top-[166] w-[232] h-[65] flex-col rounded-[8] bg-white border border-[#a4abb3] overflow-hidden">
          {Field("email", () => card().email, true)}
          <View class="w-full h-[1] bg-[#c9ced4]" />
          {Field("birthday", () => card().birthday, false)}
        </View>
      </View>

      <AuxiliarySurface>
        <View debugName="Contacts" class="relative w-full h-full bg-white overflow-hidden">
          <View debugName="ContactsTable" class="absolute left-0 right-0 top-[36] bottom-0">
            <VirtualList
              surface="auxiliary"
              controller={listScroller}
              count={LIST_SLOTS}
              rowHeight={SLOT}
              height={LIST_HEIGHT}
              overscan={ROW_HEIGHT}
              focusRows={false}
              renderRow={renderSlot}
              onRowPress={selectSlot}
            />

            <View
              class={pinnedSection() < 0 ? "hidden" : "absolute left-0 right-0 top-0 h-[18]"}
              style={{ translateY: pinnedShift() }}
            >
              {SectionHeader(pinnedLetter, "PinnedSection")}
            </View>
          </View>

          <View
            debugName="ContactsNavigation"
            class="absolute left-0 right-0 top-0 h-[36] bg-[#6d7e99]"
          >
            <View class="absolute left-0 right-0 top-0 h-[18] bg-gradient-to-b from-[#b2becf] to-[#8d9cb4]" />
            <View class="absolute left-0 right-0 top-[18] h-[18] bg-gradient-to-b from-[#7d8ea8] to-[#66778f]" />
            <View class="absolute left-0 right-0 top-0 h-[1] bg-[#ccd4df]" />
            <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />

            <Text class="absolute left-[62] right-[62] top-[7] text-center text-base text-[#3c4d6480] font-bold">All Contacts</Text>
            <Text class="absolute left-[62] right-[62] top-[8] text-center text-base text-white font-bold">All Contacts</Text>

            <View class="absolute left-[4] top-[6] w-[52] h-[24] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]">
              <View class="absolute left-[2] right-[2] top-[1] h-[1] bg-[#c8d1de80]" />
              <Text class="absolute left-0 right-0 top-[3] text-center text-xs text-[#39495f80] font-bold">Groups</Text>
              <Text class="absolute left-0 right-0 top-[4] text-center text-xs text-white font-bold">Groups</Text>
            </View>

            <View
              debugName="ContactsAdd"
              class="absolute right-[4] top-[6] w-[26] h-[24] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]"
            >
              <View class="absolute left-[2] right-[2] top-[1] h-[1] bg-[#c8d1de80]" />
              <View class="absolute left-[7] top-[10] w-[11] h-[3] bg-white" />
              <View class="absolute left-[11] top-[6] w-[3] h-[11] bg-white" />
            </View>
          </View>

          <View
            debugName="ContactsIndex"
            ref={(node) => (contactIndexNode = node)}
            class={
              indexing()
                ? "absolute right-0 top-[36] bottom-0 w-[20] rounded-[8] bg-[#9aa3ad99]"
                : "absolute right-0 top-[36] bottom-0 w-[20]"
            }
          >
            {INDEX_ENTRIES.map((entry, index) => (
              <View
                class="absolute right-0 w-[15] flex-row items-center justify-center"
                style={{ insetT: INDEX_PAD + index * INDEX_PITCH, height: INDEX_PITCH }}
              >
                {entry === null
                  ? <View class="w-[3] h-[3] rounded-full bg-[#2f5288]" />
                  : <Text class="text-xs text-[#2f5288]">{entry}</Text>}
              </View>
            ))}
          </View>
        </View>
      </AuxiliarySurface>
    </>
  );
}
