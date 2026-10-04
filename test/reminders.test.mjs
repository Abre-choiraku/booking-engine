// リマインドの既定値・既定文・送信時刻の見張りテスト。
// 実行: npm test（Node の型はがし機能で .ts を直接読む。追加の道具は不要）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REMINDERS,
  defaultReminderMessage,
  resolveReminderMessage,
  reminderFireTime,
} from "../src/core/reminders.ts";

const jst = (s) => Date.parse(`${s}+09:00`);

test("既定のリマインドは「1日前の9:00」と「1時間前」の2本", () => {
  assert.deepEqual(DEFAULT_REMINDERS, [
    { kind: "at", days_before: 1, time: "09:00" },
    { kind: "before", hours: 1 },
  ]);
});

test("送信時刻: 1日前の9:00 は予約日の前日 朝9時(JST)", () => {
  const start = jst("2026-10-10T14:00:00");
  assert.equal(
    reminderFireTime({ kind: "at", days_before: 1, time: "09:00" }, start),
    jst("2026-10-09T09:00:00"),
  );
});

test("送信時刻: 深夜0時台の予約でも「前日」は日本時間の前日", () => {
  const start = jst("2026-10-10T00:30:00");
  assert.equal(
    reminderFireTime({ kind: "at", days_before: 1, time: "09:00" }, start),
    jst("2026-10-09T09:00:00"),
  );
});

test("送信時刻: 1時間前 は開始のちょうど60分前", () => {
  const start = jst("2026-10-10T14:00:00");
  assert.equal(
    reminderFireTime({ kind: "before", hours: 1 }, start),
    jst("2026-10-10T13:00:00"),
  );
});

test("送信時刻: 0時間前など無効な設定は送らない(null)", () => {
  assert.equal(reminderFireTime({ kind: "before", hours: 0 }, jst("2026-10-10T14:00:00")), null);
});

test("既定文: 1日前は「明日はご予約日です」", () => {
  const m = defaultReminderMessage({ kind: "at", days_before: 1, time: "09:00" }, { online: false });
  assert.match(m, /^明日はご予約日です。/);
});

test("既定文: 当日の時刻指定は「本日はご予約日です」", () => {
  const m = defaultReminderMessage({ kind: "at", days_before: 0, time: "08:00" }, { online: false });
  assert.match(m, /^本日はご予約日です。/);
});

test("既定文: 2日以上前は「近づいてまいりました」", () => {
  const m = defaultReminderMessage({ kind: "at", days_before: 3, time: "09:00" }, { online: false });
  assert.match(m, /^ご予約日が近づいてまいりました。/);
});

test("既定文: 1時間前・来店は「お気をつけてお越しください」", () => {
  const m = defaultReminderMessage({ kind: "before", hours: 1 }, { online: false });
  assert.equal(m, "まもなくご予約のお時間です。\nお気をつけてお越しください。");
});

test("既定文: 1時間前・Web会議は URL からの参加を案内", () => {
  const m = defaultReminderMessage({ kind: "before", hours: 1 }, { online: true });
  assert.match(m, /ご案内のURLからご参加ください/);
  assert.doesNotMatch(m, /お越しください/);
  // LINEではURLが文より上に出るので「下記」とは書かない
  assert.doesNotMatch(m, /下記/);
});

test("既定文: Web会議なのにURLが無い予約には「下記のURL」と書かない", () => {
  const m = defaultReminderMessage({ kind: "before", hours: 1 }, { online: true, hasUrl: false });
  assert.doesNotMatch(m, /URL/);
  assert.doesNotMatch(m, /お越しください/);
});

test("既定文: 場所が空の予約（電話相談など）には「お越しください」と書かない", () => {
  for (const c of [
    { kind: "before", hours: 1 },
    { kind: "at", days_before: 0, time: "08:00" },
  ]) {
    const m = defaultReminderMessage(c, { online: false, hasPlace: false });
    assert.doesNotMatch(m, /お越しください/);
  }
});

test("既定文: 24時間前など離れた「◯時間前」は来店/参加を急かさない", () => {
  const m = defaultReminderMessage({ kind: "before", hours: 24 }, { online: false });
  assert.doesNotMatch(m, /まもなく/);
});

test("文面の決まり方: 個別 → 共通 → 既定文 の順", () => {
  const c = { kind: "before", hours: 1 };
  const o = { online: false };
  assert.equal(resolveReminderMessage({ ...c, message: " 個別 " }, "共通", o), "個別");
  assert.equal(resolveReminderMessage({ ...c, message: "  " }, " 共通 ", o), "共通");
  assert.equal(resolveReminderMessage({ ...c, message: null }, null, o), defaultReminderMessage(c, o));
  assert.equal(resolveReminderMessage(c, "   ", o), defaultReminderMessage(c, o));
});
