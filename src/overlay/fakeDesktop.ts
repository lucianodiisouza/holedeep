// Synthetic "desktop" texture for the browser demo mode (no Tauri, no real
// screenshot): a dark editor full of colorful code-ish lines, so the lensing
// has recognizable content to devour.
export function makeFakeDesktop(width: number, height: number): Uint8Array {
  const cv = document.createElement("canvas");
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext("2d")!;

  ctx.fillStyle = "#16161e";
  ctx.fillRect(0, 0, width, height);

  // editor window
  const wx = width * 0.04, wy = height * 0.06, ww = width * 0.92, wh = height * 0.88;
  ctx.fillStyle = "#1a1b26";
  ctx.fillRect(wx, wy, ww, wh);
  ctx.fillStyle = "#24283b";
  ctx.fillRect(wx, wy, ww, height * 0.035);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = ["#f7768e", "#e0af68", "#9ece6a"][i];
    ctx.beginPath();
    ctx.arc(wx + 18 + i * 22, wy + height * 0.0175, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  const palette = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#c0caf5", "#f7768e"];
  const lineH = Math.max(14, Math.round(height / 48));
  const fontPx = Math.round(lineH * 0.7);
  ctx.font = `${fontPx}px monospace`;
  let y = wy + height * 0.035 + lineH * 1.4;
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  while (y < wy + wh - lineH) {
    ctx.fillStyle = "#3b4261";
    ctx.fillText(String(Math.round((y - wy) / lineH)).padStart(3, " "), wx + 8, y);
    let x = wx + 70 + rand() * 90;
    const words = 2 + Math.floor(rand() * 6);
    for (let wgt = 0; wgt < words && x < wx + ww - 120; wgt++) {
      const len = 30 + rand() * 130;
      ctx.fillStyle = palette[Math.floor(rand() * palette.length)];
      ctx.fillRect(x, y - fontPx + 2, len, fontPx - 2);
      x += len + 14 + rand() * 30;
    }
    y += lineH;
  }

  // a few glowing "syntax" words for texture variety
  ctx.fillStyle = "#c0caf5";
  for (let i = 0; i < 24; i++) {
    ctx.fillText(
      ["const", "fn", "async", "await", "impl", "return", "match", "pub"][i % 8],
      wx + 80 + rand() * ww * 0.7,
      wy + 60 + rand() * wh * 0.85,
    );
  }

  return new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
}
