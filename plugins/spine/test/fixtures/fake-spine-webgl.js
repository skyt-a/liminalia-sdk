/**
 * テスト用の偽の Spine のランタイム（本物は Spine のライセンスを持つ人がそれぞれ入手するもので、エンジンには入れない。docs/live2d-spine.md）。
 * spine-webgl の IIFE の版と同じく window.spine を置き、このプラグインが使う口だけを持つ。骨格は JSON で、四角形で描く:
 * 体（差分の動きの色、無ければ待機の動きの色）、目（まばたきの段が動いている間は消える）、口（口パクの段の時間で高さが変わる）。
 * 本物のランタイムの代わりにはならない（このプラグインの呼び方と描き方の計算を確かめるためだけのもの）。
 *
 * 偽の骨格: { "skeleton": { "x", "y", "width", "height" }, "animations": { 名前: { "duration", "color": [r, g, b] } }, "skins": [名前] }
 */
(function () {
  class ManagedWebGLRenderingContext {
    constructor(canvas, config) {
      this.gl = canvas.getContext("webgl", config);
    }
  }
  class GLTexture {
    constructor(context, image) {
      const gl = context.gl;
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      this.width = image.width;
    }
    dispose() {}
  }
  class TextureAtlas {
    constructor(text) {
      this.pages = text
        .split(/\r?\n/)
        .filter((l) => /\.(png|webp|jpg)$/i.test(l.trim()))
        .map((name) => ({ name: name.trim(), pma: /pma:\s*true/.test(text), texture: null, setTexture(t) { this.texture = t; } }));
    }
    dispose() {}
  }
  class AtlasAttachmentLoader {
    constructor(atlas) {
      this.atlas = atlas;
    }
  }
  function readData(text) {
    const j = JSON.parse(text);
    const animations = Object.entries(j.animations ?? {}).map(([name, a]) => ({ name, duration: a.duration ?? 1, color: a.color ?? [0.5, 0.5, 0.5] }));
    const skins = (j.skins ?? ["default"]).map((name) => ({ name }));
    return {
      ...j.skeleton,
      animations,
      skins,
      findAnimation: (n) => animations.find((a) => a.name === n) ?? null,
      findSkin: (n) => skins.find((s) => s.name === n) ?? null,
    };
  }
  class SkeletonJson {
    constructor(loader) {
      this.loader = loader;
      this.scale = 1;
    }
    readSkeletonData(json) {
      return readData(typeof json === "string" ? json : JSON.stringify(json));
    }
  }
  class SkeletonBinary {
    constructor(loader) {
      this.loader = loader;
      this.scale = 1;
    }
    readSkeletonData(bytes) {
      return readData(new TextDecoder().decode(bytes));
    }
  }
  class Skeleton {
    constructor(data) {
      this.data = data;
      this.skin = "default";
      this.pose = [];
    }
    setToSetupPose() {}
    setSlotsToSetupPose() {}
    setSkinByName(name) {
      if (!this.data.findSkin(name)) throw new Error(`Skin not found: ${name}`);
      this.skin = name;
    }
    updateWorldTransform() {}
    update() {}
    getBounds(offset, size) {
      offset.x = this.data.x;
      offset.y = this.data.y;
      size.x = this.data.width;
      size.y = this.data.height;
    }
  }
  class AnimationStateData {
    constructor(data) {
      this.skeletonData = data;
      this.defaultMix = 0;
    }
  }
  class AnimationState {
    constructor(data) {
      this.data = data;
      this.tracks = [];
      this.queue = [];
    }
    entry(name, loop) {
      const animation = this.data.skeletonData.findAnimation(name);
      if (!animation) throw new Error(`Animation not found: ${name}`);
      return { animation, loop, trackTime: 0, timeScale: 1, mixDuration: this.data.defaultMix };
    }
    setAnimation(track, name, loop) {
      const e = this.entry(name, loop);
      this.tracks[track] = e;
      this.queue[track] = null;
      return e;
    }
    setEmptyAnimation(track, mix) {
      this.tracks[track] = null;
      this.queue[track] = null;
      return { animation: null, trackTime: 0, timeScale: 1, mixDuration: mix };
    }
    addEmptyAnimation(track, mix) {
      const e = { animation: null, trackTime: 0, timeScale: 1, mixDuration: mix, empty: true };
      this.queue[track] = e;
      return e;
    }
    update(dt) {
      this.tracks.forEach((e, i) => {
        if (!e) return;
        e.trackTime += dt * e.timeScale;
        if (!e.loop && e.timeScale > 0 && e.trackTime >= e.animation.duration && this.queue[i]) {
          this.tracks[i] = null;
          this.queue[i] = null;
        }
      });
    }
    apply(skeleton) {
      skeleton.pose = this.tracks.map((e) => (e ? { name: e.animation.name, color: e.animation.color, t: e.loop ? e.trackTime % e.animation.duration : Math.min(e.trackTime, e.animation.duration), duration: e.animation.duration } : null));
      return true;
    }
  }

  const VERTEX = "attribute vec2 a_pos; uniform mat4 u_projTrans; void main() { gl_Position = u_projTrans * vec4(a_pos, 0.0, 1.0); }";
  const FRAGMENT = "precision mediump float; uniform vec4 u_color; void main() { gl_FragColor = vec4(u_color.rgb * u_color.a, u_color.a); }";
  class Shader {
    constructor(context) {
      const gl = (this.gl = context.gl);
      const make = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      this.program = gl.createProgram();
      gl.attachShader(this.program, make(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(this.program, make(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(this.program);
      this.buffer = gl.createBuffer();
    }
    static newTwoColoredTextured(context) {
      return new Shader(context);
    }
    bind() {
      this.gl.useProgram(this.program);
    }
    unbind() {
      this.gl.useProgram(null);
    }
    setUniformi() {}
    setUniform4x4f(name, values) {
      this.gl.uniformMatrix4fv(this.gl.getUniformLocation(this.program, name), false, new Float32Array(values));
    }
    rect(x, y, w, h, color) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x, y, x + w, y, x + w, y + h, x, y, x + w, y + h, x, y + h]), gl.DYNAMIC_DRAW);
      const loc = gl.getAttribLocation(this.program, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(gl.getUniformLocation(this.program, "u_color"), color[0], color[1], color[2], 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }
  Shader.MVP_MATRIX = "u_projTrans";
  Shader.SAMPLER = "u_texture";

  class PolygonBatcher {
    constructor(context) {
      this.gl = context.gl;
    }
    begin(shader) {
      this.shader = shader;
      this.gl.enable(this.gl.BLEND);
      this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
    }
    end() {}
  }
  class SkeletonRenderer {
    constructor() {
      this.premultipliedAlpha = false;
    }
    draw(batcher, skeleton) {
      const d = skeleton.data;
      const [idle, variant, blink, mouth] = [0, 1, 2, 3].map((i) => skeleton.pose[i] ?? null);
      const body = (variant ?? idle)?.color ?? [0.5, 0.5, 0.5];
      const s = batcher.shader;
      s.rect(d.x, d.y, d.width, d.height, skeleton.skin === "winter" ? [0, 0, 1] : body);
      if (!blink) s.rect(d.x + d.width * 0.25, d.y + d.height * 0.7, d.width * 0.5, d.height * 0.08, [1, 1, 1]);
      const open = mouth && mouth.duration > 0 ? mouth.t / mouth.duration : 0;
      if (open > 0) s.rect(d.x + d.width * 0.4, d.y + d.height * (0.55 - 0.2 * open), d.width * 0.2, d.height * 0.2 * open, [0, 0, 0]);
    }
  }
  class Matrix4 {
    constructor() {
      this.values = new Float32Array(16);
    }
    ortho2d(x, y, width, height) {
      const v = this.values.fill(0);
      v[0] = 2 / width;
      v[5] = 2 / height;
      v[10] = -1;
      v[12] = -(2 * x + width) / width;
      v[13] = -(2 * y + height) / height;
      v[15] = 1;
      return this;
    }
  }
  class Vector2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
  }

  globalThis.spine = { ManagedWebGLRenderingContext, GLTexture, TextureAtlas, AtlasAttachmentLoader, SkeletonJson, SkeletonBinary, Skeleton, AnimationStateData, AnimationState, Shader, PolygonBatcher, SkeletonRenderer, Matrix4, Vector2, Physics: { update: "update" }, fake: true };
})();
