import fs from "fs";
const src=fs.readFileSync(new URL("../src/ui.ts",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../styles.css",import.meta.url),"utf8");
const required=["private autoFollow = true","private scrollFrame: number | null","new ResizeObserver","private isNearBottom","private applyBottomScroll","Coalesce every append/render/collapse","this.autoFollow = false"];
for(const token of required)if(!src.includes(token))throw new Error("Scroll controller missing: "+token);
const writes=(src.match(/scrollTop\s*=/g)||[]).length;if(writes!==1)throw new Error("Expected one centralized scrollTop write, found "+writes);
for(const token of ["scroll-behavior: auto !important","overflow-anchor: none !important","overscroll-behavior: contain"])if(!css.includes(token))throw new Error("Stable scroll CSS missing: "+token);
console.log("SCROLL_STABILITY_OK");
