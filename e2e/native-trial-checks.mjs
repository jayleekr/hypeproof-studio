// Observed model output uses both 오후 7:00 and 오후 7시.
export function hasClosingTime(text, hour) {
  const time = hour === 19 ? '(?:19\\s*(?::\\s*00|시)|오후\\s*(?:7\\s*(?::\\s*00|시)|일곱\\s*시))'
    : '(?:18\\s*(?::\\s*00|시)|오후\\s*(?:6\\s*(?::\\s*00|시)|여섯\\s*시))';
  return new RegExp(time).test(text);
}
