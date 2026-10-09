import * as THREE from 'three'

/**
 * Тающая крона: деревья выше человека закрывали фигурки на наклонной камере.
 * Шейдер листвы прореживает фрагменты внутри цилиндра «фигурка → камера»
 * сеткой Байера — к оси окна крона редеет до просвета, так что герой и враг
 * видны сквозь листву, а дерево остаётся деревом. Работает и на объединённых
 * инстансах (`board3d-batching`): решение принимается по пикселю, а не по
 * предмету. Вариант выбран владельцем 2026-10-09 из трёх (окно, тающая крона,
 * силуэт фигурки).
 */
export const SEE_THROUGH_MAX_TARGETS = 16
/** Радиус окна в клетках вокруг оси «фигурка → камера». */
export const SEE_THROUGH_RADIUS = 1.15

const VERTEX_DECLARATION = 'varying vec3 vSeeThroughWorld;\n'
const VERTEX_BODY = `
  vec4 seeThroughWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    seeThroughWorld = instanceMatrix * seeThroughWorld;
  #endif
  vSeeThroughWorld = (modelMatrix * seeThroughWorld).xyz;
`
const FRAGMENT_DECLARATION = `
varying vec3 vSeeThroughWorld;
uniform vec4 seeThroughTargets[${SEE_THROUGH_MAX_TARGETS}];
uniform int seeThroughCount;
float seeThroughBayer(vec2 coord) {
  vec2 cell = mod(floor(coord), 4.0);
  float index = cell.x + cell.y * 4.0;
  // Матрица Байера 4×4: ровная сетка вместо шума, без мерцания при повороте.
  float value = 0.0;
  if (index < 0.5) value = 0.0; else if (index < 1.5) value = 8.0; else if (index < 2.5) value = 2.0; else if (index < 3.5) value = 10.0;
  else if (index < 4.5) value = 12.0; else if (index < 5.5) value = 4.0; else if (index < 6.5) value = 14.0; else if (index < 7.5) value = 6.0;
  else if (index < 8.5) value = 3.0; else if (index < 9.5) value = 11.0; else if (index < 10.5) value = 1.0; else if (index < 11.5) value = 9.0;
  else if (index < 12.5) value = 15.0; else if (index < 13.5) value = 7.0; else if (index < 14.5) value = 13.0; else value = 5.0;
  return (value + 0.5) / 16.0;
}
`
const FRAGMENT_BODY = `
  for (int i = 0; i < ${SEE_THROUGH_MAX_TARGETS}; i++) {
    if (i >= seeThroughCount) break;
    vec3 target = seeThroughTargets[i].xyz;
    float radius = seeThroughTargets[i].w;
    vec3 toCamera = cameraPosition - target;
    float span = length(toCamera);
    vec3 axis = toCamera / max(span, 0.0001);
    vec3 offset = vSeeThroughWorld - target;
    float along = dot(offset, axis);
    // Только то, что между фигуркой и камерой: крона за спиной остаётся.
    if (along < 0.2 || along > span) continue;
    float fade = 1.0 - smoothstep(radius * 0.45, radius * 1.25, length(offset - axis * along));
    if (fade > seeThroughBayer(gl_FragCoord.xy)) discard;
  }
`

/**
 * Общие для всех крон сцены uniform-ы: цели пишутся раз в кадр, материалы
 * читают их без пересборки шейдера.
 */
export function createSeeThrough() {
  const uniforms = {
    seeThroughTargets: { value: Array.from({ length: SEE_THROUGH_MAX_TARGETS }, () => new THREE.Vector4()) },
    seeThroughCount: { value: 0 },
  }
  const patched = new Map<THREE.Material, THREE.Material>()

  /** Копия материала кроны с окном; одна копия на исходный материал — объединение не ломается. */
  function patch(material: THREE.Material): THREE.Material {
    const existing = patched.get(material)
    if (existing) return existing
    const copy = material.clone()
    copy.name = `${material.name || 'foliage'}:see-through`
    copy.onBeforeCompile = (shader, renderer) => {
      material.onBeforeCompile?.(shader, renderer)
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = VERTEX_DECLARATION + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_BODY}`)
      shader.fragmentShader = FRAGMENT_DECLARATION + shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAGMENT_BODY}`)
    }
    copy.customProgramCacheKey = () => `${material.customProgramCacheKey?.() ?? ''}|see-through`
    patched.set(material, copy)
    return copy
  }

  return {
    patch,
    /** Середины фигурок в мире на этот кадр; сверх предела — отбрасываются, пустой список — без окон. */
    setTargets(points: ReadonlyArray<{ x: number; y: number; z: number; radius?: number }>) {
      const count = Math.min(points.length, SEE_THROUGH_MAX_TARGETS)
      for (let index = 0; index < count; index += 1) {
        const point = points[index]
        uniforms.seeThroughTargets.value[index].set(point.x, point.y, point.z, point.radius ?? SEE_THROUGH_RADIUS)
      }
      uniforms.seeThroughCount.value = count
    },
    get targetCount() { return uniforms.seeThroughCount.value },
    dispose() {
      for (const material of patched.values()) material.dispose()
      patched.clear()
    },
  }
}

export type SeeThrough = ReturnType<typeof createSeeThrough>
