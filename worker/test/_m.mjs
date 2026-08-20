import "./harness/loader.mjs";
const { matchWorld } = await import("../src/skeletons/kids-quest/worlds.ts");
for (const t of ["🐿️ 도토 세상에 가볼래","도토 세상에 가볼래","도토!","도토","다른 친구도 있어?","🐧 뽀로 세상에 가볼래","뽀로","도토 얘기 들려줘","다람쥐 세상","도토한테 가자"]) {
  console.log(JSON.stringify(t), "→", matchWorld(t)?.id ?? "MISS");
}
