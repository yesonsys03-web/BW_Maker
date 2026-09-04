import { expect, test } from "vitest";
import { missingFromChunk, nextThumbnailChunk } from "./thumbnailQueue";

const none = new Set<number>();

test("takes only what is still missing, up to the chunk size", () => {
  expect(nextThumbnailChunk([1, 2, 3, 4], { 2: "data:..." }, none, 2)).toEqual([1, 3]);
});

test("skips ids that already failed — retrying them never lets the queue finish", () => {
  expect(nextThumbnailChunk([1, 2, 3], undefined, new Set([1, 2]), 8)).toEqual([3]);
});

test("nothing left to do returns an empty chunk, which is how the drain stops", () => {
  expect(nextThumbnailChunk([1, 2], { 1: "a", 2: "b" }, none, 8)).toEqual([]);
});

test("keeps the order it was given — visible rows come top to bottom", () => {
  expect(nextThumbnailChunk([9, 4, 7], undefined, none, 8)).toEqual([9, 4, 7]);
});

// 엔진이 요청한 id를 다 돌려주지 않으면 그 id는 영원히 "아직 못 받음"으로 남아
// 같은 묶음이 계속 다시 나간다.
test("ids the engine did not answer are reported so they can be given up on", () => {
  expect(missingFromChunk([1, 2, 3], { "1": "/a.png", "3": "/c.png" })).toEqual([2]);
});

test("a fully answered chunk leaves nothing behind", () => {
  expect(missingFromChunk([1, 2], { "1": "/a.png", "2": "/b.png" })).toEqual([]);
});
