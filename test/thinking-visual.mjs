import fs from "node:fs";
const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const start = css.indexOf(".agenter-typing-visual {");
const end = css.indexOf(".agenter-typing-head .agenter-typing-label", start);
if (start < 0 || end < 0) throw new Error("Thinking visual CSS block missing");
const block = css.slice(start, end);
for (const token of [
  "border-radius: 50%",
  "agenter-brain-orbit",
  "transform-origin: 50% 50%",
  "border-right-color",
  "agenter-brain-breathe",
]) if (!block.includes(token)) throw new Error(`Professional brain orbit rule missing: ${token}`);
if (block.includes("border-radius: 10px") || block.includes("animation: agenter-reasoning-orbit")) {
  throw new Error("Old flat rounded-square orbit remains");
}
console.log("THINKING_VISUAL_OK");
