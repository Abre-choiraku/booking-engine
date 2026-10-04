// Zoom連携切れの見分けと、「Web会議なのにURLが無い」の見張りテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeadZoomGrant } from "../src/zoom/errors.ts";
import { isOnlineMeeting, meetingUrlMissing } from "../src/core/meeting.ts";

test("Zoom: 本番で実際に返ってきた invalid_grant は「連携切れ」と判定する", () => {
  // 2026-10-04 本番ログ: zoom token refresh failed: 400 {"reason":"Invalid Token!","error":"invalid_grant"}
  assert.equal(isDeadZoomGrant(400, '{"reason":"Invalid Token!","error":"invalid_grant"}'), true);
});

test("Zoom: 一時的な障害（5xx・通信エラーの本文）は連携切れ扱いにしない", () => {
  assert.equal(isDeadZoomGrant(500, '{"error":"server_error"}'), false);
  assert.equal(isDeadZoomGrant(503, "Service Unavailable"), false);
  assert.equal(isDeadZoomGrant(429, '{"error":"rate_limited"}'), false);
});

test("Zoom: アプリ側の設定ミス（invalid_client）は連携切れ扱いにしない", () => {
  // これで連携を消すと、設定を直しても全員が連携し直しになる
  assert.equal(isDeadZoomGrant(401, '{"reason":"Invalid client_id or client_secret","error":"invalid_client"}'), false);
  assert.equal(isDeadZoomGrant(400, '{"error":"invalid_request"}'), false);
});

test("Zoom: 本文が読めないときは連携切れ扱いにしない", () => {
  assert.equal(isDeadZoomGrant(400, ""), false);
  assert.equal(isDeadZoomGrant(400, "<html>"), false);
});

test("Web会議の判定: zoom / meet だけがオンライン", () => {
  assert.equal(isOnlineMeeting("zoom"), true);
  assert.equal(isOnlineMeeting("meet"), true);
  assert.equal(isOnlineMeeting("none"), false);
  assert.equal(isOnlineMeeting(null), false);
  assert.equal(isOnlineMeeting(undefined), false);
});

test("URLが無いWeb会議: オンラインなのに URL が空のときだけ true", () => {
  assert.equal(meetingUrlMissing("zoom", null), true);
  assert.equal(meetingUrlMissing("meet", ""), true);
  assert.equal(meetingUrlMissing("zoom", "https://zoom.us/j/1"), false);
  assert.equal(meetingUrlMissing("none", null), false);
  assert.equal(meetingUrlMissing(undefined, null), false);
});
