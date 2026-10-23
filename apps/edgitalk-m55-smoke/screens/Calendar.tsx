import type { JSX } from "solid-js";
import { Show, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { DashboardStatus } from "../native.ts";
import { Button, Label, Panel, RoundButton } from "../ui/kit.tsx";
import { textClass, type TextTone } from "../ui/text-classes.ts";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const CELL_W = 52;
const CELL_H = 26;
const GRID_X = 6;
const GRID_Y = 26;
const ROWS = 6;
const COLS = 7;
const CELLS = ROWS * COLS;
const DISC = 24;

const CELL_INDEXES: number[] = [];
for (let i = 0; i < CELLS; i++) CELL_INDEXES.push(i);
const COLUMN_INDEXES = [0, 1, 2, 3, 4, 5, 6];

function leapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysIn(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Weekday of the first day of a month, 0 = Sunday (Gregorian). */
function firstWeekday(year: number, month: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5);
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return (((days + 4) % 7) + 7) % 7;
}

export interface CalendarProps {
  status: () => DashboardStatus;
  onBack: () => void;
}

/**
 * Month grid with today marked by a filled teal disc. The grid is always 6x7 cells and every cell
 * always holds text, so paging months only changes strings and the draw list keeps its shape.
 */
export function Calendar(props: CalendarProps): JSX.Element {
  // Months away from the current one; 0 means "this month".
  const [shift, setShift] = createSignal(0);

  const known = () => props.status().month >= 1;
  const view = () => {
    const s = props.status();
    if (s.month < 1) return { year: 0, month: 0 };
    const index = s.year * 12 + (s.month - 1) + shift();
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
  };
  const first = () => {
    const v = view();
    return v.month < 1 ? 0 : firstWeekday(v.year, v.month);
  };
  const count = () => {
    const v = view();
    return v.month < 1 ? 0 : daysIn(v.year, v.month);
  };
  const title = () => {
    const v = view();
    return v.month < 1 ? "-- ----" : `${MONTHS[v.month - 1]} ${v.year}`;
  };
  /** Cell index of today in the shown month, or -1. */
  const todayCell = () => {
    const s = props.status();
    return known() && shift() === 0 ? first() + s.day - 1 : -1;
  };

  const dayText = (cell: number) => () => {
    const day = cell - first() + 1;
    return day >= 1 && day <= count() ? `${day}` : "00";
  };
  const dayTone = (cell: number) => (): TextTone => {
    const day = cell - first() + 1;
    if (day < 1 || day > count()) return "paper";
    if (cell === todayCell()) return "white";
    const column = cell % COLS;
    return column === 0 || column === COLS - 1 ? "sub" : "ink";
  };

  return (
    <View debugName="Calendar" class="absolute left-0 top-[1200] w-[400] h-[240] bg-[#e6eff3] overflow-hidden">
      <Button debugName="CalendarBack" x={12} y={9} w={64} h={22} text="< Home" tone="light" onPress={props.onBack} />
      <RoundButton debugName="MonthPrev" x={118} y={8} size={24} text="<" onPress={() => setShift(shift() - 1)} />
      <Label x={146} y={8} w={108} h={24} text={title} size="lg" tone="ink" />
      <RoundButton debugName="MonthNext" x={258} y={8} size={24} text=">" onPress={() => setShift(shift() + 1)} />
      <Button debugName="MonthToday" x={312} y={9} w={76} h={22} text="TODAY" tone="soft" onPress={() => setShift(0)} />

      <Panel x={12} y={40} w={376} h={188}>
        {COLUMN_INDEXES.map((column) => (
          <Label x={GRID_X + column * CELL_W} y={6} w={CELL_W} h={16} text={WEEKDAYS[column]} size="xs" tone="sub" />
        ))}
        <Show when={todayCell() >= 0}>
          <View
            class="absolute bg-[#1d7974]"
            style={{
              insetL: GRID_X + (todayCell() % COLS) * CELL_W + (CELL_W - DISC) / 2,
              insetT: GRID_Y + Math.floor(todayCell() / COLS) * CELL_H + (CELL_H - DISC) / 2,
              width: DISC,
              height: DISC,
              radius: DISC / 2,
            }}
          />
        </Show>
        {CELL_INDEXES.map((cell) => (
          <View
            class="absolute items-center justify-center"
            style={{
              insetL: GRID_X + (cell % COLS) * CELL_W,
              insetT: GRID_Y + Math.floor(cell / COLS) * CELL_H,
              width: CELL_W,
              height: CELL_H,
            }}
          >
            <Text class={textClass("xsb", dayTone(cell)())}>{dayText(cell)()}</Text>
          </View>
        ))}
        <Show when={!known()}>
          <Label x={0} y={80} w={376} h={20} text="Waiting for time sync" size="sm" tone="sub" />
        </Show>
      </Panel>
    </View>
  );
}
