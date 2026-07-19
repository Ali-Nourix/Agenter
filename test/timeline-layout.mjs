import fs from "fs";
const css=fs.readFileSync(new URL("../styles.css",import.meta.url),"utf8");
const required=[
  "Agenter v1.1.13 — professional, flat activity timeline",
  ".agenter-messages > .agenter-activity-timeline",
  "flex-shrink: 0 !important",
  "height: 38px",
  "background: transparent !important",
  "border: 0 !important",
  "box-shadow: none !important",
  ".agenter-activity-step-arrow { display: none !important; }",
];
for(const rule of required)if(!css.includes(rule))throw new Error("Professional timeline rule missing: "+rule);
for(const old of ["Agenter v1.1.11 — live, collapsible activity timeline","box-shadow: 0 7px 24px","min-height: 46px !important"])if(css.includes(old))throw new Error("Old card-style timeline layer remains: "+old);
console.log("TIMELINE_PRO_DESIGN_OK");
