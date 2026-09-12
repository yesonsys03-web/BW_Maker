/**
 * 사용법 매뉴얼 스크린샷 촬영 — 데모 앱(HELP_SHOTS=1 vite)을 크롬으로 몰아
 * public/help/img/ 에 PNG를 남긴다. 상태가 코드라 릴리스마다 재촬영이 된다.
 *
 *   HELP_SHOTS=1 npx vite --port 1430 &      # 데모 서버
 *   node scripts/help-shots.mjs
 *
 * 데모 엔진(src/demo/engineDemo.ts)은 예시 판 3장만 안다 — 납품 파일명이
 * 화면에 나올 길이 없다.
 */
import puppeteer from "puppeteer-core";

const APP_URL = "http://localhost:1430/";
const OUT = new URL("../public/help/img/", import.meta.url).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 2 },
  args: ["--lang=ko"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("페이지 오류:", e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}${name}` });
  console.log("찍음:", name);
};

/** 텍스트가 정확히 일치하는 버튼을 클릭(테스트와 같은 이벤트 디스패치). */
async function clickButton(text) {
  const ok = await page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")]
      .find((el) => el.textContent?.trim() === t);
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, text);
  if (!ok) throw new Error(`버튼 없음: ${text}`);
}

async function waitText(text, timeout = 15000) {
  await page.waitForFunction(
    (t) => document.body.textContent?.includes(t), { timeout }, text);
}

/**
 * 미리보기 캔버스에 **진짜 그림**이 걸릴 때까지. `img[src^='data:image']`로
 * 기다리면 레이어 썸네일에 먼저 걸려 그림이 오기 전에 찍힌다 — 실제로 그랬다.
 */
async function waitPreview(timeout = 30000) {
  await page.waitForFunction(
    () => !!document.querySelector(".preview-canvas img"), { timeout });
  await sleep(400);
}

async function clickFileRow(name) {
  const ok = await page.evaluate((n) => {
    const row = [...document.querySelectorAll(".file-list-item")]
      .find((el) => el.textContent?.includes(n));
    if (!row) return false;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, name);
  if (!ok) throw new Error(`파일 행 없음: ${name}`);
}

await page.goto(APP_URL, { waitUntil: "networkidle0" });
await waitText("+ 추가");
await shot("01-start.png");

// ── 파일 열기 ─────────────────────────────────────────────────────────────
await page.evaluate(() => { (window.__help ??= {}).tileMs = 25; });
// 프리셋을 **먼저** 고른다. 기본 BG는 예시 판(캐릭터 구조)을 하나도 못 잡아
// 미리보기가 빈 채로 남는다 — 앱의 정상 동작이지만 첫 화면 그림으로는 못 쓴다.
await page.evaluate(() => {
  const sel = [...document.querySelectorAll("select")]
    .find((s) => [...s.options].some((o) => o.textContent?.includes("CHAR")));
  if (!sel) throw new Error("프리셋 셀렉트 없음");
  sel.value = [...sel.options].find((o) => o.textContent?.includes("CHAR")).value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await sleep(300);
await clickButton("+ 추가");
await waitText("예시_캐릭터_A.psd");
await page.waitForFunction(
  () => document.body.textContent.split("열림").length >= 4, { timeout: 30000 });
await clickFileRow("예시_캐릭터_A.psd");
await sleep(1200);
await shot("02-files-open.png");   // 목록·레이어 트리가 찬 상태(적용 전)

// ── CHAR 프리셋 적용 → 경계선 미리보기 ────────────────────────────────────
await clickButton("적용");
await sleep(400);
await waitPreview();
await shot("03-preset-char.png");

// 내보내질 그림만: 레이어 트리의 "라인만"
try {
  await clickButton("라인만");
  await sleep(900);
  await shot("03b-lines-only.png");
  await clickButton("전체");
  await sleep(400);
} catch (e) {
  console.log("라인만 생략:", e.message);
}

// ── 내보내기 대화상자 ─────────────────────────────────────────────────────
try {
  await clickButton("내보내기...");
  await sleep(600);
  await shot("04-export.png");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find((el) => ["취소", "닫기"].includes(el.textContent?.trim()));
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(300);
} catch (e) {
  console.log("내보내기 대화상자 생략:", e.message);
}

// ── 배치 탭 ───────────────────────────────────────────────────────────────
await clickButton("배치");
await sleep(400);
await shot("05-batch.png");
await clickButton("히스토리");
await sleep(200);

// ── "나머지 레이어 준비 중" 진행바 — 아직 안 데운 소품 판에서 ────────────
await page.evaluate(() => { window.__help.tileMs = 700; });
// 캐릭터_B는 "다음 파일" 자동 워밍업이 미리 데운다 — 자동이 안 닿는
// 세 번째 파일이라야 진행바가 남아 있다.
await clickFileRow("예시_소품.psd");
try {
  await page.waitForFunction(
    () => /나머지 레이어 준비 중\.\.\. [1-9]/.test(document.body.textContent ?? ""),
    { timeout: 25000 });
  await page.evaluate(() => { window.__help.freezeWarm = true; });
  await sleep(500);
  await shot("06-warm-progress.png");
} finally {
  await page.evaluate(() => {
    window.__help.freezeWarm = false; window.__help.tileMs = 15;
  });
}
await sleep(2500);

// ── 전체 캐시 (작업 프로세스 1 = 이 체인이 돈다) ──────────────────────────
await page.evaluate(() => {
  const sel = [...document.querySelectorAll("select")]
    .find((s) => (s.title || "").includes("작업 프로세스"));
  if (!sel) throw new Error("작업 프로세스 셀렉트 없음");
  sel.value = "1";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  window.__help.tileMs = 500;
});
await sleep(300);
await clickButton("전체 캐시");
try {
  await waitText("전체 캐시 만드는 중", 20000);
  await page.evaluate(() => { window.__help.freezeWarm = true; });
  await sleep(500);
  await shot("07-full-cache.png");
} finally {
  await page.evaluate(() => {
    window.__help.freezeWarm = false; window.__help.tileMs = 10;
  });
}
await waitText("전체 캐시 완료", 60000);
await shot("08-full-cache-done.png");

await browser.close();
console.log("완료");
