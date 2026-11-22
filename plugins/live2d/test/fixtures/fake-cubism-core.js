/**
 * テスト用の偽の Cubism Core（本物の Core は同梱できないため。docs/live2d-spine.md）。本物と同じ形の口（Live2DCubismCore.Moc・Model）を持ち、
 * .moc3 の代わりに JSON を読む。描くものは四角形で、パラメーターで動く・大きさが変わる・消えるものを書ける。
 * 本物の Core の代わりにはならない（このプラグインの読み方と描き方を確かめるためだけのもの）。
 *
 * 偽の .moc3（JSON）:
 * { "canvas": { "width", "height", "ppu" }, "parameters": [{ "id", "min", "max", "default" }], "parts": ["id"],
 *   "drawables": [{ "id", "rect": [x0, y0, x1, y1], "uv": [u0, v0, u1, v1], "texture", "order", "part",
 *                   "moveX": { "param", "k" }, "grow": { "param" }, "show": { "param" }, "uvSwap": { "param", "uv" }, "masks": [番号], "flags" }] }
 */
(function () {
  const IS_VISIBLE = 1;

  class Moc {
    constructor(spec) {
      this.spec = spec;
    }
    static fromArrayBuffer(buffer) {
      try {
        return new Moc(JSON.parse(new TextDecoder().decode(new Uint8Array(buffer))));
      } catch {
        return null;
      }
    }
    _release() {}
  }

  class Model {
    constructor(spec) {
      this.spec = spec;
      const params = spec.parameters;
      this.parameters = {
        count: params.length,
        ids: params.map((p) => p.id),
        minimumValues: new Float32Array(params.map((p) => p.min)),
        maximumValues: new Float32Array(params.map((p) => p.max)),
        defaultValues: new Float32Array(params.map((p) => p.default)),
        values: new Float32Array(params.map((p) => p.default)),
      };
      this.parts = { count: spec.parts.length, ids: [...spec.parts], opacities: new Float32Array(spec.parts.length).fill(1) };
      const list = spec.drawables;
      const n = list.length;
      this.drawables = {
        count: n,
        ids: list.map((d) => d.id),
        constantFlags: new Uint8Array(list.map((d) => d.flags ?? 0)),
        dynamicFlags: new Uint8Array(n),
        textureIndices: new Int32Array(list.map((d) => d.texture ?? 0)),
        renderOrders: new Int32Array(list.map((d, i) => d.order ?? i)),
        opacities: new Float32Array(n),
        maskCounts: new Int32Array(list.map((d) => (d.masks ?? []).length)),
        masks: list.map((d) => new Int32Array(d.masks ?? [])),
        vertexPositions: list.map(() => new Float32Array(8)),
        vertexUvs: list.map(() => new Float32Array(8)),
        indices: list.map(() => new Uint16Array([0, 1, 2, 0, 2, 3])),
        multiplyColors: new Float32Array(n * 4).fill(1),
        screenColors: new Float32Array(n * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)),
        resetDynamicFlags: () => {
          for (let i = 0; i < n; i++) this.drawables.dynamicFlags[i] &= IS_VISIBLE;
        },
      };
      const c = spec.canvas;
      this.canvasinfo = { CanvasWidth: c.width, CanvasHeight: c.height, CanvasOriginX: c.width / 2, CanvasOriginY: c.height / 2, PixelsPerUnit: c.ppu };
      this.update();
    }
    value(id) {
      const i = this.parameters.ids.indexOf(id);
      return i < 0 ? 0 : this.parameters.values[i];
    }
    update() {
      const d = this.drawables;
      this.spec.drawables.forEach((s, i) => {
        let [x0, y0, x1, y1] = s.rect;
        if (s.moveX) {
          const dx = this.value(s.moveX.param) * s.moveX.k;
          x0 += dx;
          x1 += dx;
        }
        if (s.grow) y0 = y1 - (y1 - y0) * this.value(s.grow.param);
        let [u0, v0, u1, v1] = s.uv;
        if (s.uvSwap && this.value(s.uvSwap.param) > 0.5) [u0, v0, u1, v1] = s.uvSwap.uv;
        // 頂点は左下、右下、右上、左上（反時計回り）
        d.vertexPositions[i].set([x0, y0, x1, y0, x1, y1, x0, y1]);
        // UV は下が 0（Cubism と同じ）
        d.vertexUvs[i].set([u0, 1 - v1, u1, 1 - v1, u1, 1 - v0, u0, 1 - v0]);
        const part = s.part ? this.parts.ids.indexOf(s.part) : -1;
        let opacity = part >= 0 ? this.parts.opacities[part] : 1;
        if (s.show) opacity *= this.value(s.show.param);
        d.opacities[i] = opacity;
        d.dynamicFlags[i] = opacity > 0 && y1 - y0 > 0 ? IS_VISIBLE : 0;
      });
    }
    release() {}
    static fromMoc(moc) {
      return moc && moc.spec ? new Model(moc.spec) : null;
    }
  }

  globalThis.Live2DCubismCore = { Moc, Model, fake: true };
})();
