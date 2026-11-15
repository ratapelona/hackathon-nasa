(() => {
  "use strict";
  const h3 = (x, y, z) => { const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123; return n - Math.floor(n); };
  function n3(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz), lp = (a, b, t) => a + (b - a) * t;
    return lp(lp(lp(h3(ix, iy, iz), h3(ix + 1, iy, iz), ux), lp(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), ux), uy),
      lp(lp(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), ux), lp(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), ux), uy), uz);
  }
  function fbm3(x, y, z, oct = 4) {
    let v = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { v += a * (n3(x * f, y * f, z * f) * 2 - 1); f *= 2.07; a *= 0.5; }
    return v;
  }

  function makeSphereTex(THREE, mode) {
    const w = mode === "moon" ? 256 : 512, h = mode === "moon" ? 128 : 256;
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d");
    if (mode === "solar") {
      cv.width = 128; cv.height = 128; g.fillStyle = "#081c3a"; g.fillRect(0, 0, 128, 128); g.strokeStyle = "#38bdf8"; g.lineWidth = 1;
      for (let i = 0; i < 128; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); }
      g.strokeStyle = "rgba(251,191,36,0.45)";
      for (let i = 8; i < 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke(); }
      return new THREE.CanvasTexture(cv);
    }
    const img = g.createImageData(w, h), d = img.data;
    const craters = mode === "mars" || mode === "moon" ? Array.from({ length: 34 }, (_, i) => [((i * 0.618) % 1) * 2 - 1, ((i * 0.37) % 1) * 1.4 - 0.7, 0.04 + (i % 5) * 0.025]) : [];
    for (let y = 0; y < h; y++) {
      const lat = (0.5 - y / h) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < w; x++) {
        const lon = (x / w) * Math.PI * 2, sx = cl * Math.cos(lon), sy = sl, sz = cl * Math.sin(lon), idx = (y * w + x) * 4;
        if (mode === "clouds") {
          const c = fbm3(sx * 2.8 + 4.1, sy * 2.8, sz * 2.8, 4) + 0.35 * fbm3(sx * 7.2, sy * 7.2, sz * 7.2, 2);
          d[idx] = 242; d[idx + 1] = 248; d[idx + 2] = 255; d[idx + 3] = Math.max(0, Math.min(255, (c - 0.04) * 520)); continue;
        }
        if (mode === "earth") {
          const e = fbm3(sx * 2.1 + 1.3, sy * 2.1 - 0.7, sz * 2.1 + 2.4, 4), m = fbm3(sx * 3.5 + 8.0, sy * 3.5, sz * 3.5, 3);
          let r, gr, b;
          if (Math.abs(sy) > 0.85 - e * 0.08) { r = 232; gr = 242; b = 252; }
          else if (e < 0.02) { const sh = Math.max(0, 1 + e * 4.5); r = 8 + sh * 18; gr = 38 + sh * 82; b = 88 + sh * 96; }
          else if (e > 0.28) { r = 178 + e * 90; gr = 174 + e * 90; b = 178 + e * 85; }
          else if (m > 0.14 && Math.abs(sy) < 0.55) { r = 178; gr = 148; b = 102; }
          else { const h0 = Math.min(1, e * 3.2); r = 34 + h0 * 48; gr = 92 + h0 * 44; b = 46 + h0 * 24; }
          d[idx] = r; d[idx + 1] = gr; d[idx + 2] = b; d[idx + 3] = 255; continue;
        }
        const n = fbm3(sx * 2.5 + 3.2, sy * 2.5 + 1.1, sz * 2.5, 4); let cr = 0;
        for (const [cx, cy, rad] of craters) {
          const dist = Math.hypot(sx - cx, sy - cy, sz - Math.sqrt(Math.max(0, 1 - cx * cx - cy * cy)));
          if (dist < rad) cr = dist > rad * 0.78 ? 0.18 : -0.22;
        }
        if (mode === "moon") {
          const val = Math.max(45, Math.min(225, 132 + n * 78 + cr * 95));
          d[idx] = val; d[idx + 1] = val * 0.99; d[idx + 2] = val * 0.97; d[idx + 3] = 255; continue;
        }
        const valles = Math.abs(sy + 0.04) < 0.065 && lon > 1.7 && lon < 3.1 ? -0.32 * (1 - Math.abs(sy + 0.04) / 0.065) : 0;
        if (Math.abs(sy) > 0.88 - n * 0.05) { d[idx] = 244; d[idx + 1] = 236; d[idx + 2] = 228; d[idx + 3] = 255; }
        else { const k = Math.max(-0.5, Math.min(0.6, n + cr + valles)); d[idx] = Math.max(40, Math.min(245, 174 + k * 95)); d[idx + 1] = Math.max(20, Math.min(185, 86 + k * 68)); d[idx + 2] = Math.max(14, Math.min(125, 46 + k * 42)); d[idx + 3] = 255; }
      }
    }
    g.putImageData(img, 0, 0); const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; return tex;
  }

  function atmoShader(THREE, colHex, powVal = 2.6, mult = 0.92) {
    return new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(colHex) }, uPow: { value: powVal }, uMult: { value: mult }, uSun: { value: new THREE.Vector3(0.7, 0.35, 0.6).normalize() } },
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vN=normalize(mat3(modelMatrix)*normal); vV=normalize(cameraPosition-wp.xyz); gl_Position=projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `uniform vec3 uCol; uniform float uPow; uniform float uMult; uniform vec3 uSun; varying vec3 vN; varying vec3 vV; void main(){ vec3 N=normalize(vN); float rim=pow(1.0-clamp(abs(dot(N,normalize(vV))),0.0,1.0),uPow); float day=smoothstep(-0.35,0.65,dot(-N,uSun)); float a=clamp(rim*uMult*(0.28+0.72*day),0.0,0.92); gl_FragColor=vec4(uCol*rim*(0.7+0.9*day),a); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
    });
  }

  function buildPlanetSystem(THREE) {
    const mk = (geo, mat, pos = {}, rot = null) => { const m = new THREE.Mesh(geo, mat); Object.assign(m.position, pos); if (rot) m.rotation.set(rot[0], rot[1], rot[2]); return m; };
    const earthTex = makeSphereTex(THREE, "earth"), cloudTex = makeSphereTex(THREE, "clouds"), marsTex = makeSphereTex(THREE, "mars"), moonTex = makeSphereTex(THREE, "moon");
    const earthGroup = new THREE.Group();
    const earthSphere = mk(new THREE.SphereGeometry(3.0, 64, 48), new THREE.MeshStandardMaterial({ map: earthTex, bumpMap: earthTex, bumpScale: 0.045, roughness: 0.58, metalness: 0.1 }));
    const earthClouds = mk(new THREE.SphereGeometry(3.045, 56, 40), new THREE.MeshStandardMaterial({ map: cloudTex, transparent: true, opacity: 0.72, depthWrite: false, roughness: 0.95 }));
    const earthAtmo = mk(new THREE.SphereGeometry(3.16, 48, 36), atmoShader(THREE, 0x38bdf8, 2.5, 0.95));
    const moon = mk(new THREE.SphereGeometry(0.42, 28, 20), new THREE.MeshStandardMaterial({ map: moonTex, bumpMap: moonTex, bumpScale: 0.03, roughness: 0.92 }), { x: 5.4, y: 1.4, z: -2.2 });
    earthGroup.add(earthSphere, earthClouds, earthAtmo, moon);

    const marsGroup = new THREE.Group();
    const marsSphere = mk(new THREE.SphereGeometry(2.75, 64, 48), new THREE.MeshStandardMaterial({ map: marsTex, bumpMap: marsTex, bumpScale: 0.08, roughness: 0.88, metalness: 0.04 }));
    const marsAtmo = mk(new THREE.SphereGeometry(2.91, 48, 36), atmoShader(THREE, 0xf0823d, 2.7, 0.9));
    const marsOrbit = mk(new THREE.TorusGeometry(3.65, 0.012, 8, 120), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.48 }), {}, [1.22, 0.25, 0]);
    const phobos = mk(new THREE.DodecahedronGeometry(0.18, 1), new THREE.MeshStandardMaterial({ map: moonTex, color: 0xb99d8b, roughness: 0.95 }), { x: -3.5, y: 0.9, z: 0.6 });
    marsGroup.add(marsSphere, marsAtmo, marsOrbit, phobos);

    const sPos = new Float32Array(900 * 3), sCol = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const th = h3(i, 1, 2) * Math.PI * 2, ph = Math.acos(2 * h3(i, 3, 4) - 1), r = 34 + h3(i, 5, 6) * 26;
      sPos[i * 3] = r * Math.sin(ph) * Math.cos(th); sPos[i * 3 + 1] = r * Math.cos(ph); sPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      const t = i % 7 === 0 ? [0.65, 0.85, 1.0] : i % 11 === 0 ? [1.0, 0.86, 0.7] : [0.95, 0.96, 1.0];
      sCol[i * 3] = t[0]; sCol[i * 3 + 1] = t[1]; sCol[i * 3 + 2] = t[2];
    }
    const sGeo = new THREE.BufferGeometry(); sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3)); sGeo.setAttribute("color", new THREE.BufferAttribute(sCol, 3));
    const starField = new THREE.Points(sGeo, new THREE.PointsMaterial({ size: 0.14, vertexColors: true, transparent: true, opacity: 0.78, depthWrite: false }));
    return { earthGroup, earthSphere, earthClouds, moon, marsGroup, marsSphere, phobos, starField, solarTex: makeSphereTex(THREE, "solar") };
  }

  function buildSatellites(THREE, solarTex) {
    const mk = (geo, mat, pos = {}, rot = null) => { const m = new THREE.Mesh(geo, mat); Object.assign(m.position, pos); if (rot) m.rotation.set(rot[0], rot[1], rot[2]); return m; };
    const hull = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 0.82, roughness: 0.26 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x262930, metalness: 0.85, roughness: 0.34 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xd4a238, metalness: 0.9, roughness: 0.25 });
    const radM = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, metalness: 0.2, roughness: 0.45 });
    const solar = new THREE.MeshStandardMaterial({ map: solarTex, metalness: 0.65, roughness: 0.24, emissive: 0x0a2540, emissiveIntensity: 0.35 });
    const winM = new THREE.MeshBasicMaterial({ color: 0x67e8f9 });

    const issGroup = new THREE.Group(), navLights = [];
    issGroup.add(mk(new THREE.BoxGeometry(5.2, 0.08, 0.08), dark), mk(new THREE.CylinderGeometry(0.15, 0.15, 2.3, 18), hull, {}, [0, 0, Math.PI / 2]), mk(new THREE.CylinderGeometry(0.16, 0.16, 1.5, 18), hull, { z: 0.1 }, [Math.PI / 2, 0, 0]));
    issGroup.add(mk(new THREE.CylinderGeometry(0.12, 0.14, 0.65, 14), gold, { x: -0.95 }, [0, 0, Math.PI / 2]), mk(new THREE.SphereGeometry(0.11, 12, 8), winM, { y: -0.14, z: 0.35 }), mk(new THREE.ConeGeometry(0.16, 0.12, 16, 1, true), hull, { y: 0.22, x: 0.2 }, [0.4, 0, 0]));
    for (const rx of [-0.55, 0.55]) issGroup.add(mk(new THREE.BoxGeometry(0.28, 0.015, 0.72), radM, { x: rx, z: -0.52 }));
    for (const sx of [-2.25, -1.7, 1.7, 2.25]) for (const sz of [-0.68, 0.68]) issGroup.add(mk(new THREE.BoxGeometry(0.36, 0.018, 1.12), solar, { x: sx, z: sz }), mk(new THREE.CylinderGeometry(0.02, 0.02, 1.24, 6), gold, { x: sx, z: sz * 0.5 }, [Math.PI / 2, 0, 0]));
    for (const [bx, col] of [[-2.6, 0xf64137], [2.6, 0x47da84]]) { const b = mk(new THREE.SphereGeometry(0.038, 8, 8), new THREE.MeshBasicMaterial({ color: col }), { x: bx, y: 0.08 }); navLights.push(b); issGroup.add(b); }

    const saffireGroup = new THREE.Group();
    saffireGroup.add(mk(new THREE.CylinderGeometry(0.32, 0.32, 1.15, 24), hull, {}, [0, 0, Math.PI / 2]), mk(new THREE.CylinderGeometry(0.24, 0.31, 0.42, 24), gold, { x: -0.78 }, [0, 0, Math.PI / 2]), mk(new THREE.ConeGeometry(0.14, 0.24, 16, 1, true), dark, { x: -1.06 }, [0, 0, Math.PI / 2]));
    for (const rx of [-0.35, 0, 0.35]) saffireGroup.add(mk(new THREE.TorusGeometry(0.33, 0.018, 8, 24), dark, { x: rx }, [0, Math.PI / 2, 0]));
    for (const sz of [-1.05, 1.05]) saffireGroup.add(mk(new THREE.CylinderGeometry(0.66, 0.66, 0.022, 10), solar, { x: -0.68, z: sz }, [Math.PI / 2, 0, 0]), mk(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 12), gold, { x: -0.68, z: sz }, [Math.PI / 2, 0, 0]));

    const paraGroup = new THREE.Group(), plane = new THREE.Group(), bellyMat = new THREE.MeshStandardMaterial({ color: 0xff7832, emissive: 0xf64137, emissiveIntensity: 1.5, roughness: 0.35 });
    plane.add(mk(new THREE.CylinderGeometry(0.24, 0.2, 2.5, 20), hull, {}, [0, 0, Math.PI / 2]), mk(new THREE.ConeGeometry(0.24, 0.55, 20), hull, { x: 1.52 }, [0, 0, -Math.PI / 2]), mk(new THREE.BoxGeometry(0.55, 0.04, 2.8), hull, { x: 0.05 }), mk(new THREE.BoxGeometry(0.36, 0.58, 0.04), hull, { x: -1.1, y: 0.32 }), mk(new THREE.BoxGeometry(0.28, 0.03, 1.05), hull, { x: -1.12, y: 0.06 }), mk(new THREE.BoxGeometry(0.22, 0.14, 0.22), winM, { x: 1.15, y: 0.14 }));
    plane.add(mk(new THREE.CylinderGeometry(0.25, 0.21, 2.2, 16, 1, true, -Math.PI * 0.35, Math.PI * 0.7), bellyMat, { y: -0.04 }, [0, 0, Math.PI / 2]));
    paraGroup.add(plane);
    return { issGroup, navLights, saffireGroup, paraGroup, plane, bellyMat };
  }

  function buildReentryEffect(THREE, TUBE_R, TUBE_HALF) {
    const group = new THREE.Group(), pts = [];
    for (let i = 0; i <= 20; i++) {
      const k = i / 20;
      pts.push(k < 0.45 ? new THREE.Vector2(Math.sin((k / 0.45) * Math.PI * 0.5) * (TUBE_R * 1.24), -TUBE_HALF - 0.46 + Math.pow(k / 0.45, 2) * 0.44)
        : new THREE.Vector2(TUBE_R * (1.24 + ((k - 0.45) / 0.55) * 0.14), -TUBE_HALF + ((k - 0.45) / 0.55) * (TUBE_HALF * 1.95)));
    }
    const plasmaMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uInt: { value: 0 } },
      vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv=uv; vec4 wp=modelMatrix*vec4(position,1.0); vN=normalize(mat3(modelMatrix)*normal); vV=normalize(cameraPosition-wp.xyz); gl_Position=projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `uniform float uTime; uniform float uInt; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float ns(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
        void main(){ float rim=pow(1.0-clamp(abs(dot(normalize(vN),normalize(vV))),0.0,1.0),1.4); float bow=pow(1.0-vUv.y,2.2);
          float st=ns(vec2(vUv.x*22.0, vUv.y*8.0-uTime*5.2))*0.65+ns(vec2(vUv.x*44.0, vUv.y*16.0-uTime*9.0))*0.35;
          vec3 col=mix(vec3(0.95,0.22,0.06), vec3(1.0,0.72,0.28), bow*0.8+st*0.35); col=mix(col, vec3(0.65,0.45,1.0), smoothstep(0.5,0.95,vUv.y)*0.55);
          float a=clamp((bow*0.85+rim*0.6)*(0.35+0.85*st)*uInt, 0.0, 0.88); gl_FragColor=vec4(col*1.45, a); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const bowMesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), plasmaMat);
    const shieldMat = new THREE.MeshBasicMaterial({ color: 0xff6b2b, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false });
    const shieldRing = new THREE.Mesh(new THREE.TorusGeometry(TUBE_R * 1.06, 0.055, 12, 48), shieldMat);
    shieldRing.rotation.x = Math.PI / 2; shieldRing.position.y = -TUBE_HALF - 0.08;
    const N = 96, sPos = new Float32Array(N * 6), sCol = new Float32Array(N * 6), seeds = [];
    for (let i = 0; i < N; i++) {
      seeds.push({ ang: h3(i, 7, 1) * Math.PI * 2, rad: TUBE_R * (1.16 + h3(i, 2, 9) * 1.1), len: 0.25 + h3(i, 4, 8) * 0.55, spd: 1.6 + h3(i, 3, 5) * 1.9, off: h3(i, 8, 2) });
      const c = i % 4 === 0 ? [1.0, 0.92, 0.7] : i % 3 === 0 ? [0.7, 0.6, 1.0] : [1.0, 0.45, 0.12];
      sCol.set(c, i * 6); sCol.set([c[0] * 0.2, c[1] * 0.2, c[2] * 0.2], i * 6 + 3);
    }
    const sGeo = new THREE.BufferGeometry(); sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3)); sGeo.setAttribute("color", new THREE.BufferAttribute(sCol, 3));
    const streaksMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false });
    const streaks = new THREE.LineSegments(sGeo, streaksMat);
    group.add(bowMesh, shieldRing, streaks); group.visible = false;
    return { group, plasmaMat, shieldMat, streaks, sPos, seeds, streaksMat, N };
  }

  globalThis.NasaCelestialAssets = { buildPlanetSystem, buildSatellites, buildReentryEffect };
})();
