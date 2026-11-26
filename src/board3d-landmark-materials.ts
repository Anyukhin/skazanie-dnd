import type * as THREE from 'three'

/** Фактура в масштабе доски: мелкие поры кости и продольные волокна дерева
 * сглаживаются при отдалении камеры. Новые текстуры модели не загружают. */
export function finishLandmarkMaterial(material: THREE.MeshStandardMaterial, surface: 'bone' | 'wood') {
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 vLandmark;\n' + shader.vertexShader.replace('#include <project_vertex>', `
      #include <project_vertex>
      vec4 surfacePoint = vec4(transformed,1.);
      #ifdef USE_INSTANCING
        surfacePoint = instanceMatrix * surfacePoint;
      #endif
      vLandmark = (modelMatrix * surfacePoint).xyz;
    `)
    shader.fragmentShader = `varying vec3 vLandmark;
      float fleck(vec2 p) {
        vec3 v = fract(vec3(p.xyx)*.1031);
        v += dot(v, v.yzx + 33.33);
        return fract((v.x+v.y)*v.z);
      }
      float mineralNoise(vec2 p) {
        vec2 a=floor(p), t=fract(p); t=t*t*(3.-2.*t);
        return mix(mix(fleck(a), fleck(a+vec2(1,0)), t.x),
                   mix(fleck(a+vec2(0,1)),fleck(a+1.),t.x),t.y);
      }\n` + shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 uv = vLandmark.xz + vec2(.39,.74)*vLandmark.y;
        ${surface === 'bone' ? `
        float stain=mineralNoise(uv*8.5), pore=mineralNoise(uv*90.);
        float fine=1.-smoothstep(.4,1.2,length(fwidth(uv*90.)));
        diffuseColor.rgb *= .79+.29*stain+.12*fine*(pore-.5);
        diffuseColor.rgb *= mix(vec3(1.),vec3(.76,.62,.54),smoothstep(.65,.91,stain+.09*(pore-.5)*fine));
        ` : `
        float ripple = mineralNoise(vec2(uv.x*4.,uv.y*9.));
        vec2 grainUv=vec2(uv.x*3.,uv.y*62.+ripple*3.);
        float fine=1.-smoothstep(.4,1.2,length(fwidth(grainUv)));
        diffuseColor.rgb *= .81+.23*ripple + fine*.25*(mineralNoise(grainUv)-.45);
        `}
      `)
  }
  material.customProgramCacheKey = () => 'landmark-finish-' + surface
  return material
}
