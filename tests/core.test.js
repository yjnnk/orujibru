const assert = require("assert");
const {
  resolvePath,
  segmentText,
  escapeRegExp,
  inferLangFromVoice,
  findSegmentIndexByOffset,
  useSpineForClick,
} = require("../core.js");

function testResolvePath() {
  assert.strictEqual(
    resolvePath("OEBPS/content.opf", "text/ch1.xhtml"),
    "OEBPS/text/ch1.xhtml"
  );
  assert.strictEqual(
    resolvePath("OEBPS/content.opf", "../Images/cover.jpg"),
    "Images/cover.jpg"
  );
  assert.strictEqual(resolvePath("", "/root/file.xhtml"), "root/file.xhtml");
}

function testSegmentText() {
  const text = "One two three four five. Six seven eight nine ten.";
  const segments = segmentText(text, 20);
  assert.ok(segments.length >= 2, "Expected segmentation for small maxLen");
  assert.ok(segments.every((s) => s.length <= 20 || s.includes(".")));
}

function testEscapeRegExp() {
  assert.strictEqual(escapeRegExp("a+b*c?"), "a\\+b\\*c\\?");
}

function testInferLangFromVoice() {
  assert.strictEqual(inferLangFromVoice("am_michael"), "en-us");
  assert.strictEqual(inferLangFromVoice("pt_br_voice"), "pt-br");
  assert.strictEqual(inferLangFromVoice("en_gb_voice"), "en-gb");
}

function testFindSegmentIndexByOffset() {
  const offsets = [0, 10, 20];
  const heights = [10, 10, 10];
  assert.strictEqual(findSegmentIndexByOffset(0, offsets, heights), 0);
  assert.strictEqual(findSegmentIndexByOffset(9, offsets, heights), 0);
  assert.strictEqual(findSegmentIndexByOffset(10, offsets, heights), 1);
  assert.strictEqual(findSegmentIndexByOffset(25, offsets, heights), 2);
}

function testUseSpineForClick() {
  assert.strictEqual(useSpineForClick(true, false), true);
  assert.strictEqual(useSpineForClick(true, true), false);
  assert.strictEqual(useSpineForClick(false, false), false);
}

function run() {
  testResolvePath();
  testSegmentText();
  testEscapeRegExp();
  testInferLangFromVoice();
  testFindSegmentIndexByOffset();
  testUseSpineForClick();
  console.log("core.test.js ok");
}

run();
