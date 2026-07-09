/* Minimal three.js stand-in for headless smoke tests. Implements just
 * the surface app.js touches, as no-ops that don't require a GPU. */
function V3() { return { x: 0, y: 0, z: 0,
  set: function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
  sub: function () { return this; },
  getSize: function (t) { t.x = 1; t.y = 1; t.z = 1; return t; },
  getCenter: function (t) { t.x = 0; t.y = 0; t.z = 0; return t; } }; }
export class Vector3 { constructor() { return V3(); } }
export class Color { constructor() {} }
export class Scene { constructor() { this.background = null; } add() {} }
export class PerspectiveCamera { constructor() { this.position = V3(); this.up = V3(); this.aspect = 1; } lookAt() {} updateProjectionMatrix() {} }
export class WebGLRenderer { constructor() {} setPixelRatio() {} setSize() {} render() {} dispose() {} }
export class AmbientLight { constructor() {} }
export class DirectionalLight { constructor() { this.position = V3(); } }
export class BufferAttribute { constructor(a) { this.array = a; } }
export class BufferGeometry {
  setAttribute() {} setIndex() {} computeVertexNormals() {}
  computeBoundingBox() { this.boundingBox = { getSize: function (t) { t.x = 200; t.y = 180; t.z = 15; return t; }, getCenter: function (t) { t.x = 0; t.y = 0; t.z = 0; return t; } }; }
}
export class MeshStandardMaterial { constructor() {} }
export class Mesh { constructor() { this.position = V3(); this.rotation = V3(); } }
export { V3 as _V3 };
window.__threeStubLoaded = true;
