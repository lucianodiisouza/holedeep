import { VERT, FRAG } from "./shader";

// Geodesic integration at full 5K Retina resolution is wasteful for a
// distortion effect — render the backing store at half density and let the
// browser upscale. Visually free, roughly 4x cheaper.
const RESOLUTION_SCALE = 0.5;

export interface Renderer {
  /** Upload a desktop frame. Pass null data when capture failed. */
  setScreen(width: number, height: number, data: Uint8Array | null, bgra?: boolean): void;
  render(timeSec: number, intensity: number, holeRadius: number): void;
  resize(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: false,
    stencil: false,
    alpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL2 not available");

  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.useProgram(prog);

  const uni = {
    screen: gl.getUniformLocation(prog, "uScreen"),
    resolution: gl.getUniformLocation(prog, "uResolution"),
    time: gl.getUniformLocation(prog, "uTime"),
    intensity: gl.getUniformLocation(prog, "uIntensity"),
    holeRadius: gl.getUniformLocation(prog, "uHoleRadius"),
    hasScreen: gl.getUniformLocation(prog, "uHasScreen"),
    swapBGR: gl.getUniformLocation(prog, "uSwapBGR"),
  };

  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(uni.screen, 0);
  gl.uniform1f(uni.hasScreen, 0);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(window.innerWidth * dpr * RESOLUTION_SCALE));
    const h = Math.max(1, Math.round(window.innerHeight * dpr * RESOLUTION_SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  resize();
  window.addEventListener("resize", resize);

  let texW = 0;
  let texH = 0;

  return {
    setScreen(width, height, data, bgra = false) {
      if (!data || width === 0 || height === 0) {
        gl.uniform1f(uni.hasScreen, 0);
        return;
      }
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      if (width > max || height > max) {
        console.warn(`screenshot ${width}x${height} exceeds MAX_TEXTURE_SIZE ${max}`);
        gl.uniform1f(uni.hasScreen, 0);
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // no UNPACK_FLIP: row 0 (top of the screen) lands at v = 0, matching
      // the shader's y-down uv convention. Live frames stream at 15 fps, so
      // reuse the allocation when dimensions repeat.
      if (width === texW && height === texH) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        texW = width;
        texH = height;
      }
      gl.uniform1f(uni.hasScreen, 1);
      gl.uniform1f(uni.swapBGR, bgra ? 1 : 0);
    },
    render(timeSec, intensity, holeRadius) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uni.resolution, canvas.width, canvas.height);
      gl.uniform1f(uni.time, timeSec);
      gl.uniform1f(uni.intensity, intensity);
      gl.uniform1f(uni.holeRadius, holeRadius);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    resize,
  };
}
