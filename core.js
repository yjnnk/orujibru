/* eslint-disable no-useless-escape */
(function () {
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function inferLangFromVoice(voice) {
    if (!voice) return "";
    const v = voice.toLowerCase();
    if (v.includes("pt") || v.includes("br")) return "pt-br";
    if (v.includes("gb") || v.includes("uk")) return "en-gb";
    if (v.includes("en") || v.startsWith("am_")) return "en-us";
    if (v.includes("es")) return "es-es";
    if (v.includes("fr")) return "fr-fr";
    if (v.includes("de")) return "de-de";
    if (v.includes("it")) return "it-it";
    return "";
  }

  function resolvePath(base, relative) {
    if (!relative) return "";
    if (relative.startsWith("/")) return relative.replace(/^\//, "");
    const baseParts = base ? base.split("/") : [];
    baseParts.pop();
    const relParts = relative.split("/");
    const out = [...baseParts];
    relParts.forEach((part) => {
      if (!part || part === ".") return;
      if (part === "..") {
        out.pop();
        return;
      }
      out.push(part);
    });
    return out.join("/");
  }

  function splitSentences(text) {
    const matches = text.match(/[^.!?]+[.!?]+\s*/g);
    if (!matches) return [text];
    const tail = text.replace(matches.join(""), "").trim();
    if (tail) matches.push(tail);
    return matches.map((part) => part.trim()).filter(Boolean);
  }

  function segmentText(text, maxLen = 1000) {
    const rawSegments = text
      .split(/\n{2,}/)
      .map((seg) => seg.trim())
      .filter(Boolean);

    const results = [];
    rawSegments.forEach((seg) => {
      if (seg.length <= maxLen) {
        results.push(seg);
        return;
      }
      const sentences = splitSentences(seg);
      let current = "";
      sentences.forEach((sentence) => {
        if ((current + " " + sentence).trim().length > maxLen) {
          if (current) results.push(current.trim());
          current = sentence;
        } else {
          current = `${current} ${sentence}`.trim();
        }
      });
      if (current) results.push(current.trim());
    });

    return results;
  }

  function findSegmentIndexByOffset(offset, offsets, heights) {
    let low = 0;
    let high = offsets.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const start = offsets[mid];
      const end = start + heights[mid];
      if (offset < start) {
        high = mid - 1;
      } else if (offset > end) {
        low = mid + 1;
      } else {
        return mid;
      }
    }
    return Math.max(0, Math.min(offsets.length - 1, low));
  }

  function useSpineForClick(isFullBookView, isPdf) {
    return !!isFullBookView && !isPdf;
  }

  const EpubCore = {
    escapeRegExp,
    inferLangFromVoice,
    resolvePath,
    splitSentences,
    segmentText,
    findSegmentIndexByOffset,
    useSpineForClick,
  };

  if (typeof window !== "undefined") {
    window.EpubCore = EpubCore;
  }
  if (typeof module !== "undefined") {
    module.exports = EpubCore;
  }
})();
