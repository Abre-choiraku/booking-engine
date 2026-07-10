declare module "japanese-holidays" {
  export function isHoliday(date: Date): string | undefined;
  export function isHolidayAt(date: Date): string | undefined;
  const _default: {
    isHoliday: (date: Date) => string | undefined;
  };
  export default _default;
}
