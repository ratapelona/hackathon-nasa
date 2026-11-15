(() => {
  "use strict";
  const LAYERS = [
    { id: "troposphere", r: 3.16, col: 0x38bdf8, op: 0.24 },
    { id: "stratosphere", r: 3.34, col: 0x288bff, op: 0.20 },
    { id: "mesosphere", r: 3.54, col: 0x818cf8, op: 0.17 },
    { id: "thermosphere", r: 3.76, col: 0xf472b6, op: 0.15 },
  ];

  function makePlanetTex(THREE, mode) {
    const cv = document.createElement("canvas"); cv.width = 256; cv.height = 128; const g = cv.getContext("2d");
    if (mode === "solar") {
      g.fillStyle = "#0b1e3d"; g.fillRect(0, 0, 256, 128); g.strokeStyle = "#38bdf8"; g.lineWidth = 1;
      for (let x = 0; x < 256; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
      for (let y = 0; y < 128; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
      return new THREE.CanvasTexture(cv);
    }
    const isMars = mode === "mars";
    g.fillStyle = isMars ? "#9a4e19" : "#0b3d91"; g.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 65; i++) {
      const x = ((i * 73) % 256), y = 14 + ((i * 41) % 100), rx = 8 + (i % 5) * 6, ry = 5 + (i % 4) * 4;
      g.fillStyle = isMars ? (i % 3 === 0 ? "#c9743b" : i % 2 === 0 ? "#6e310c" : "#d99b66") : (i % 3 === 0 ? "#2f7a4d" : "#4b9460");
      g.beginPath(); g.ellipse(x, y, rx, ry, (i % 7) * 0.4, 0, Math.PI * 2); g.fill();
    }
    if (isMars) {
      g.fillStyle = "rgba(255,245,235,0.72)"; g.fillRect(0, 0, 256, 8); g.fillRect(0, 120, 256, 8);
      for (let i = 0; i < 28; i++) { g.strokeStyle = "rgba(61,31,10,0.55)"; g.beginPath(); g.arc((i * 53) % 256, 18 + (i * 29) % 92, 3 + (i % 5), 0, Math.PI * 2); g.stroke(); }
    } else {
      g.fillStyle = "rgba(255,255,255,0.35)";
      for (let i = 0; i < 24; i++) { g.beginPath(); g.ellipse((i * 61) % 256, 12 + (i * 37) % 104, 14 + (i % 4) * 5, 3, 0, 0, Math.PI * 2); g.fill(); }
    }
    return new THREE.CanvasTexture(cv);
  }

  function atmoMat(THREE, colHex, powVal = 2.6, mult = 0.85) {
    return new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(colHex) }, uPow: { value: powVal }, uMult: { value: mult } },
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vN=normalize(mat3(modelMatrix)*normal); vV=normalize(cameraPosition-wp.xyz); gl_Position=projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `uniform vec3 uCol; uniform float uPow; uniform float uMult; varying vec3 vN; varying vec3 vV; void main(){ float f=pow(1.0-clamp(abs(dot(normalize(vN),normalize(vV))),0.0,1.0),uPow); gl_FragColor=vec4(uCol*f*1.4, clamp(f*uMult,0.0,0.85)); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
    });
  }

  function buildEnvScenes(THREE) {
    const root = new THREE.Group(), mk = (geo, mat, pos = {}, rot = null) => { const m = new THREE.Mesh(geo, mat); Object.assign(m.position, pos); if (rot) m.rotation.set(rot[0], rot[1], rot[2]); return m; };
    const sun = new THREE.DirectionalLight(0xfff5e4, 2.2); sun.position.set(12, 6, 10); root.add(sun);
    const solarMat = new THREE.MeshStandardMaterial({ map: makePlanetTex(THREE, "solar"), metalness: 0.65, roughness: 0.25, emissive: 0x0a2540, emissiveIntensity: 0.35 });
    const hullMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.82, roughness: 0.28 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x252527, metalness: 0.85, roughness: 0.35 });

    // 1. Tierra + 4 capas atmosféricas visibles por fuera
    const earthTex = makePlanetTex(THREE, "earth"), earthGroup = new THREE.Group();
    earthGroup.position.set(0, -1.2, -7.2);
    const earthSphere = mk(new THREE.SphereGeometry(3.0, 48, 36), new THREE.MeshStandardMaterial({ map: earthTex, bumpMap: earthTex, bumpScale: 0.04, roughness: 0.65, metalness: 0.08 }));
    const earthAtmo = mk(new THREE.SphereGeometry(3.12, 48, 36), atmoMat(THREE, 0x288bff, 2.5, 0.9));
    const layerMeshes = {};
    earthGroup.add(earthSphere, earthAtmo);
    for (const l of LAYERS) {
      const lm = mk(new THREE.SphereGeometry(l.r, 40, 28), new THREE.MeshBasicMaterial({ color: l.col, transparent: true, opacity: l.op, wireframe: false, side: THREE.DoubleSide, depthWrite: false }));
      const wire = mk(new THREE.SphereGeometry(l.r + 0.01, 24, 16), new THREE.MeshBasicMaterial({ color: l.col, transparent: true, opacity: 0.14, wireframe: true, depthWrite: false }));
      lm.add(wire); layerMeshes[l.id] = { mesh: lm, wire, baseOp: l.op }; earthGroup.add(lm);
    }

    // 2. Marte (estética JPL Eyes: esfera óxido + halo Fresnel dorado/naranja + órbita)
    const marsTex = makePlanetTex(THREE, "mars"), marsGroup = new THREE.Group();
    marsGroup.position.set(0, -1.0, -7.0);
    const marsSphere = mk(new THREE.SphereGeometry(2.75, 48, 36), new THREE.MeshStandardMaterial({ map: marsTex, bumpMap: marsTex, bumpScale: 0.06, roughness: 0.85, metalness: 0.04 }));
    const marsAtmo = mk(new THREE.SphereGeometry(2.92, 48, 36), atmoMat(THREE, 0xea6f24, 2.8, 0.88));
    const marsOrbit = mk(new THREE.TorusGeometry(3.55, 0.012, 8, 96), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45 }), {}, [1.22, 0.25, 0]);
    marsGroup.add(marsSphere, marsAtmo, marsOrbit);

    // 3. Estación Espacial Internacional (ISS)
    const issGroup = new THREE.Group(); issGroup.position.set(0, 1.55, -2.6);
    issGroup.add(mk(new THREE.CylinderGeometry(0.14, 0.14, 2.4, 16), hullMat, {}, [0, 0, Math.PI / 2]));
    issGroup.add(mk(new THREE.CylinderGeometry(0.16, 0.16, 1.4, 16), hullMat, { z: 0.1 }, [Math.PI / 2, 0, 0]));
    issGroup.add(mk(new THREE.BoxGeometry(4.6, 0.08, 0.08), darkMat));
    for (const sx of [-1.9, -1.45, 1.45, 1.9]) for (const sz of [-0.65, 0.65]) issGroup.add(mk(new THREE.BoxGeometry(0.32, 0.02, 1.05), solarMat, { x: sx, z: sz }));

    // 4. Cápsula Saffire / Cygnus
    const saffireGroup = new THREE.Group(); saffireGroup.position.set(0, 1.45, -2.4);
    saffireGroup.add(mk(new THREE.CylinderGeometry(0.32, 0.32, 1.15, 24), hullMat, {}, [0, 0, Math.PI / 2]), mk(new THREE.CylinderGeometry(0.24, 0.30, 0.42, 24), darkMat, { x: -0.78 }, [0, 0, Math.PI / 2]));
    for (const sz of [-1.05, 1.05]) saffireGroup.add(mk(new THREE.CylinderGeometry(0.62, 0.62, 0.025, 24), solarMat, { x: -0.68, z: sz }, [Math.PI / 2, 0, 0]));

    // 5. Torre de Caída Libre (Drop Tower) con cápsula cayendo + calentamiento inferior
    const dropGroup = new THREE.Group(); dropGroup.position.set(0, 0, -2.6);
    for (const a of [0.78, 2.35, 3.92, 5.49]) dropGroup.add(mk(new THREE.CylinderGeometry(0.03, 0.03, 5.4, 8), darkMat, { x: Math.cos(a) * 1.45, z: Math.sin(a) * 1.45 }));
    const dropHeatMat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff4500, emissiveIntensity: 2.2, roughness: 0.3 });
    const dropCap = new THREE.Group();
    const dropPlume = mk(new THREE.ConeGeometry(0.46, 0.65, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0xf64137, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }), { y: -0.62 }, [Math.PI, 0, 0]);
    dropCap.add(mk(new THREE.CylinderGeometry(0.34, 0.38, 0.72, 20), hullMat), mk(new THREE.SphereGeometry(0.38, 20, 12, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), dropHeatMat, { y: -0.35 }), dropPlume);
    dropGroup.add(dropCap);

    // 6. Vuelo Parabólico Zero-G (Avión en picada + calentamiento aerodinámico inferior)
    const paraGroup = new THREE.Group(); paraGroup.position.set(0, 0.4, -2.8);
    const plane = new THREE.Group(), bellyMat = new THREE.MeshStandardMaterial({ color: 0xff7832, emissive: 0xf64137, emissiveIntensity: 1.8, roughness: 0.35 });
    plane.add(mk(new THREE.CylinderGeometry(0.24, 0.20, 2.5, 20), hullMat, {}, [0, 0, Math.PI / 2]), mk(new THREE.ConeGeometry(0.24, 0.55, 20), hullMat, { x: 1.52 }, [0, 0, -Math.PI / 2]));
    plane.add(mk(new THREE.BoxGeometry(0.55, 0.04, 2.7), hullMat, { x: 0.05 }), mk(new THREE.BoxGeometry(0.35, 0.55, 0.04), hullMat, { x: -1.1, y: 0.3 }));
    const bellyGlow = mk(new THREE.CylinderGeometry(0.25, 0.21, 2.2, 16, 1, true, -Math.PI * 0.35, Math.PI * 0.7), bellyMat, { y: -0.04 }, [0, 0, Math.PI / 2]);
    plane.add(bellyGlow); paraGroup.add(plane);

    root.add(earthGroup, marsGroup, issGroup, saffireGroup, dropGroup, paraGroup);
    return {
      root, earthGroup, earthSphere, layerMeshes, marsGroup, marsSphere, issGroup, saffireGroup, dropGroup, dropCap, dropHeatMat, dropPlume, paraGroup, plane, bellyMat,
      envId: "iss_0g", zoomT: 1, zoomTarget: 1, macroMode: false,
    };
  }

  function updateEnvScenes(sys, t, dt, camera, controls) {
    if (!sys) return;
    const id = sys.envId || "iss_0g", isMars = id === "mars_038g", isDrop = id === "drop_tower", isPara = id === "parabolic_flight", isSaff = id === "saffire_exploration";
    const isAtmo = ["troposphere", "stratosphere", "mesosphere", "thermosphere"].includes(id), isISS = id === "iss_0g";
    sys.earthGroup.visible = isISS || isAtmo || isDrop || isPara;
    sys.marsGroup.visible = isMars;
    sys.issGroup.visible = isISS;
    sys.saffireGroup.visible = isSaff;
    sys.dropGroup.visible = isDrop;
    sys.paraGroup.visible = isPara;
    sys.earthSphere.rotation.y = t * 0.04;
    sys.marsSphere.rotation.y = t * 0.045;
    if (isISS) { sys.issGroup.position.y = 1.55 + Math.sin(t * 0.7) * 0.08; sys.issGroup.rotation.y = Math.sin(t * 0.25) * 0.15; }
    if (isSaff) { sys.saffireGroup.position.y = 1.45 + Math.sin(t * 0.8) * 0.08; sys.saffireGroup.rotation.z = Math.sin(t * 0.4) * 0.06; }
    for (const [k, obj] of Object.entries(sys.layerMeshes)) {
      const show = isAtmo || isISS, active = k === id;
      obj.mesh.visible = show;
      obj.mesh.material.opacity = active ? obj.baseOp * (2.0 + 0.45 * Math.sin(t * 3.0)) : isAtmo ? obj.baseOp * 0.45 : obj.baseOp * 0.25;
      obj.wire.material.opacity = active ? 0.42 : 0.08;
    }
    if (isDrop) {
      const ph = (t * 0.35) % 1, heat = Math.pow(ph, 1.6);
      sys.dropCap.position.y = 2.1 - ph * 4.2;
      sys.dropHeatMat.emissiveIntensity = 0.6 + heat * 3.4;
      sys.dropPlume.material.opacity = 0.2 + heat * 0.65;
      sys.dropPlume.scale.set(1 + heat * 0.3, 0.6 + heat * 0.9, 1 + heat * 0.3);
    }
    if (isPara) {
      const cyc = Math.sin(t * 1.15), fall = Math.max(0, -cyc);
      sys.plane.position.set(Math.sin(t * 0.6) * 0.45, cyc * 1.15, 0);
      sys.plane.rotation.z = Math.cos(t * 1.15) * 0.48;
      sys.bellyMat.emissiveIntensity = 0.4 + fall * 3.2 + 0.5 * Math.sin(t * 9.0) * fall;
    }
    const target = sys.macroMode ? 0 : sys.zoomTarget;
    if (Math.abs(sys.zoomT - target) > 0.002 && camera && controls) {
      sys.zoomT += (target - sys.zoomT) * Math.min(1, dt * 2.2);
      const s = sys.zoomT * sys.zoomT * (3 - 2 * sys.zoomT);
      camera.position.set(0, 1.35 + (0.75 - 1.35) * s, 9.6 + (5.4 - 9.6) * s);
      controls.target.set(0, (1 - s) * (isMars ? -0.35 : 0.15), (1 - s) * -2.2);
      controls.update();
    }
  }

  globalThis.NasaEnvScenes = { buildEnvScenes, updateEnvScenes };
})();
