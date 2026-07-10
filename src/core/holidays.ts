// ============================================================
// 日本の祝日判定（japanese-holidays をラップ）
// ============================================================
// 予約の空き計算で「祝日を除外」するために使う。
// 振替休日・国民の休日・春分/秋分も含めて判定される。
// ============================================================

type HolidayModule = { isHoliday: (d: Date) => string | undefined };

let _mod: HolidayModule | null = null;

async function load(): Promise<HolidayModule> {
  if (_mod) return _mod;
  const imported = (await import("japanese-holidays")) as unknown as
    | HolidayModule
    | { default: HolidayModule };
  _mod = "isHoliday" in imported ? imported : imported.default;
  return _mod;
}

// 祝日チェッカーを作る（日付範囲ループ前に一度だけ生成して同期で使う）。
// dateStr は "YYYY-MM-DD"（JST の暦日）。
export async function makeHolidayChecker(): Promise<(dateStr: string) => boolean> {
  const H = await load();
  return (dateStr: string) => {
    // JST 正午の Date にして暦日ズレを防ぐ
    const d = new Date(`${dateStr}T12:00:00+09:00`);
    return !!H.isHoliday(d);
  };
}
