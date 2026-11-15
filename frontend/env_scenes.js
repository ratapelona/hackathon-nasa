(() => {
  "use strict";
  const LAYERS = [
    { id: "troposphere", r: 3.19, col: 0x38bdf8, op: 0.22 },
    { id: "stratosphere", r: 3.36, col: 0x288bff, op: 0.18 },
    { id: "mesosphere", r: 3.55, col: 0x818cf8, op: 0.15 },
    { id: "thermosphere", r: 3.76, col: 0xf472b6, op: 0.13 },
  ];
  const CAM_PRESETS = {
    iss_0g: { sim: [0, 0.75, 5.4], tgt: [0, 0, 0], mac: [0, 1.55, 8.6], mtgt: [0, 0.2, -2.8] },
    saffire_exploration: { sim: [0.35, 0.85, 5.3], tgt: [0, 0, 0], mac: [0.9, 1.55, 7.6], mtgt: [0, 0.4, -2.5] },
    drop_tower: { sim: [0.45, 0.28, 5.15], tgt: [0, -0.15, 0], mac: [1.35, -0.35, 6.8], mtgt: [0, -0.5, -0.6] },
    parabolic_flight: { sim: [0.25, 0.7, 5.35], tgt: [0, 0, 0], mac: [0.8, 1.0, 8.0], mtgt: [0, 0.1, -2.4] },
    troposphere: { sim: [0, 0.65, 5.5], tgt: [0, 0, 0], mac: [0.4, 0.9, 9.2], mtgt: [0, -0.6, -4.5] },
    stratosphere: { sim: [0, 0.7, 5.5], tgt: [0, 0, 0], mac: [-0.4, 1.0, 9.6], mtgt: [0, -0.6, -4.5] },
    mesosphere: { sim: [0, 0.75, 5.5], tgt: [0, 0, 0], mac: [0.5, 1.1, 10.0], mtgt: [0, -0.6, -4.5] },
    thermosphere: { sim: [0, 0.8, 5.6], tgt: [0, 0, 0], mac: [0, 1.2, 10.4], mtgt: [0, -0.6, -4.5] },
    mars_038g: { sim: [0.4, 0.65, 5.3], tgt: [0, 0, 0], mac: [-0.3, 0.45, 8.8], mtgt: [0, -0.45, -3.6] },
  };
  const easeQuint = (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2);

  function buildEnvScenes(THREE) {
    const assets = globalThis.NasaCelestialAssets;
    const root = new THREE.Group();
    const sun = new THREE.DirectionalLight(0xfff5e4, 2.35); sun.position.set(12, 6, 10);
    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.45); rimLight.position.set(-10, -4, -8);
    root.add(sun, rimLight);

    const planets = assets.buildPlanetSystem(THREE);
    const sats = assets.buildSatellites(THREE, planets.solarTex);
    const reentry = assets.buildReentryEffect(THREE, 1.0, 1.8);

    planets.earthGroup.position.set(0, -1.25, -7.4);
    planets.marsGroup.position.set(22, 1.4, -24);
    sats.issGroup.position.set(0, 1.55, -2.8);
    sats.saffireGroup.position.set(0, 1.45, -2.5);
    sats.paraGroup.position.set(0, 0.45, -2.9);

    const layerMeshes = {};
    for (const l of LAYERS) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(l.r, 40, 28), new THREE.MeshBasicMaterial({ color: l.col, transparent: true, opacity: l.op, side: THREE.DoubleSide, depthWrite: false }));
      const wire = new THREE.Mesh(new THREE.SphereGeometry(l.r + 0.012, 24, 16), new THREE.MeshBasicMaterial({ color: l.col, transparent: true, opacity: 0.14, wireframe: true, depthWrite: false }));
      mesh.add(wire); layerMeshes[l.id] = { mesh, wire, baseOp: l.op }; planets.earthGroup.add(mesh);
    }

    root.add(planets.starField, planets.earthGroup, planets.marsGroup, sats.issGroup, sats.saffireGroup, sats.paraGroup, reentry.group);
    return {
      root, ...planets, ...sats, reentry, layerMeshes,
      envId: "iss_0g", prevEnvId: "iss_0g", macroMode: false,
      marsMix: 0, marsTarget: 0, flyActive: false, flyT: 1, flyDur: 1.55, flyArc: 0,
      camStart: [0, 0.75, 5.4], tgtStart: [0, 0, 0],
    };
  }

  function triggerEnvTransition(sys, envId, zoom = true, camera = null, controls = null) {
    if (!sys) return;
    const changed = sys.envId !== envId;
    sys.prevEnvId = sys.envId;
    sys.envId = envId || "iss_0g";
    sys.marsTarget = sys.envId === "mars_038g" ? 1 : 0;
    if (zoom || changed) {
      sys.flyActive = true;
      sys.flyT = 0;
      const planetSwitch = (sys.prevEnvId === "mars_038g") !== (sys.envId === "mars_038g");
      sys.flyDur = planetSwitch ? 1.75 : 1.15;
      sys.flyArc = planetSwitch ? 2.4 : 0.75;
      if (camera && controls) {
        sys.camStart = [camera.position.x, camera.position.y, camera.position.z];
        sys.tgtStart = [controls.target.x, controls.target.y, controls.target.z];
      }
    }
  }

  function updateReentry(reentry, t, intensity) {
    reentry.group.visible = intensity > 0.01;
    if (!reentry.group.visible) return;
    reentry.plasmaMat.uniforms.uTime.value = t;
    reentry.plasmaMat.uniforms.uInt.value = intensity;
    reentry.shieldMat.opacity = (0.35 + 0.15 * Math.sin(t * 18.0)) * intensity;
    reentry.streaksMat.opacity = 0.85 * intensity;
    const pos = reentry.sPos, seeds = reentry.seeds;
    for (let i = 0; i < reentry.N; i++) {
      const sd = seeds[i], ph = (t * sd.spd * (0.7 + 0.6 * intensity) + sd.off) % 1;
      const y0 = -2.35 + ph * 4.95, y1 = y0 - sd.len * (0.65 + 0.85 * intensity);
      const r = sd.rad + Math.sin(ph * 3.14) * 0.14, x = Math.cos(sd.ang) * r, z = Math.sin(sd.ang) * r;
      pos[i * 6] = x; pos[i * 6 + 1] = y0; pos[i * 6 + 2] = z;
      pos[i * 6 + 3] = x * 0.96; pos[i * 6 + 4] = y1; pos[i * 6 + 5] = z * 0.96;
    }
    reentry.streaks.geometry.attributes.position.needsUpdate = true;
  }

  function updateEnvScenes(sys, t, dt, camera, controls) {
    if (!sys) return;
    const id = sys.envId || "iss_0g", isMars = id === "mars_038g", isDrop = id === "drop_tower", isPara = id === "parabolic_flight", isSaff = id === "saffire_exploration";
    const isAtmo = ["troposphere", "stratosphere", "mesosphere", "thermosphere"].includes(id), isISS = id === "iss_0g";

    sys.marsMix += (sys.marsTarget - sys.marsMix) * Math.min(1, dt * 3.2);
    const m = easeQuint(Math.max(0, Math.min(1, sys.marsMix)));
    const dropY = isDrop ? -4.75 : -1.25, dropZ = isDrop ? -5.35 : -7.4;
    sys.earthGroup.position.set(-22 * m, dropY - 1.2 * m, dropZ - 16 * m);
    sys.marsGroup.position.set(22 * (1 - m), -0.95 + 2.3 * (1 - m), -6.8 - 17 * (1 - m));
    sys.earthGroup.visible = m < 0.995;
    sys.marsGroup.visible = m > 0.005;

    sys.issGroup.visible = isISS;
    sys.saffireGroup.visible = isSaff;
    sys.paraGroup.visible = isPara;
    sys.earthSphere.rotation.y = t * 0.032;
    sys.earthClouds.rotation.y = t * 0.044;
    sys.moon.position.set(Math.cos(t * 0.12) * 5.6, 1.3 + Math.sin(t * 0.12) * 0.5, Math.sin(t * 0.12) * 3.2 - 1.2);
    sys.marsSphere.rotation.y = t * 0.038;
    sys.phobos.position.set(Math.cos(t * 0.45) * 3.5, 0.75 * Math.sin(t * 0.45), Math.sin(t * 0.45) * 3.5);
    sys.phobos.rotation.y = t * 0.4;
    sys.starField.rotation.y = t * 0.004;

    if (isISS) {
      sys.issGroup.position.y = 1.55 + Math.sin(t * 0.7) * 0.07;
      sys.issGroup.rotation.y = Math.sin(t * 0.22) * 0.14;
      sys.navLights.forEach((b, idx) => { b.visible = Math.sin(t * 4.5 + idx * 3.1) > 0.15; });
    }
    if (isSaff) {
      sys.saffireGroup.position.y = 1.45 + Math.sin(t * 0.8) * 0.07;
      sys.saffireGroup.rotation.z = Math.sin(t * 0.38) * 0.06;
    }
    for (const [k, obj] of Object.entries(sys.layerMeshes)) {
      const show = isAtmo || isISS || isDrop, active = k === id || (isDrop && (k === "mesosphere" || k === "stratosphere"));
      obj.mesh.visible = show;
      obj.mesh.material.opacity = active ? obj.baseOp * (2.05 + 0.45 * Math.sin(t * 3.0)) : isAtmo ? obj.baseOp * 0.42 : obj.baseOp * 0.24;
      obj.wire.material.opacity = active ? 0.44 : 0.08;
    }
    let reentryInt = 0;
    if (isDrop) reentryInt = 1.0;
    else if (id === "mesosphere") reentryInt = 0.45;
    else if (id === "stratosphere") reentryInt = 0.22;
    if (isPara) {
      const cyc = Math.sin(t * 1.15), fall = Math.max(0, -cyc);
      sys.plane.position.set(Math.sin(t * 0.6) * 0.45, cyc * 1.1, 0);
      sys.plane.rotation.z = Math.cos(t * 1.15) * 0.48;
      sys.bellyMat.emissiveIntensity = 0.4 + fall * 3.2 + 0.5 * Math.sin(t * 9.0) * fall;
      reentryInt = 0.28 * fall;
    }
    updateReentry(sys.reentry, t, reentryInt);

    if (sys.flyActive && camera && controls) {
      sys.flyT = Math.min(1, sys.flyT + dt / sys.flyDur);
      const s = easeQuint(sys.flyT), arc = Math.sin(sys.flyT * Math.PI);
      const cfg = CAM_PRESETS[id] || CAM_PRESETS.iss_0g;
      const goal = sys.macroMode ? cfg.mac : cfg.sim, tgtGoal = sys.macroMode ? cfg.mtgt : cfg.tgt;
      const cx = sys.camStart[0] + (goal[0] - sys.camStart[0]) * s + Math.sin(sys.flyT * Math.PI * 2) * sys.flyArc * 0.85;
      const cy = sys.camStart[1] + (goal[1] - sys.camStart[1]) * s + arc * (1.1 + sys.flyArc * 0.65);
      const cz = sys.camStart[2] + (goal[2] - sys.camStart[2]) * s + arc * (3.2 + sys.flyArc * 1.8);
      camera.position.set(cx, cy, cz);
      controls.target.set(
        sys.tgtStart[0] + (tgtGoal[0] - sys.tgtStart[0]) * s,
        sys.tgtStart[1] + (tgtGoal[1] - sys.tgtStart[1]) * s,
        sys.tgtStart[2] + (tgtGoal[2] - sys.tgtStart[2]) * s
      );
      const targetFov = 45 + arc * (4.5 + sys.flyArc * 3.5);
      if (Math.abs(camera.fov - targetFov) > 0.05) { camera.fov = targetFov; camera.updateProjectionMatrix(); }
      controls.update();
      if (sys.flyT >= 1) { sys.flyActive = false; camera.fov = 45; camera.updateProjectionMatrix(); }
    }
  }

  globalThis.NasaEnvScenes = { buildEnvScenes, triggerEnvTransition, updateEnvScenes };
})();
