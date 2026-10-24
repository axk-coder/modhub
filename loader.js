(function() {
  const url = "https://raw.githubusercontent.com/axk-coder/modhub/refs/heads/main/modhub.js";
  console.log("Loading Mod Hub script from GitHub...");

  fetch(url)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      return response.text();
    })
    .then((code) => {
      if (typeof ModManager !== 'undefined' && ModManager.installBuiltInMod) {
        // Disable existing Mod Hub to allow clean reloading
        try {
          const existing = Array.from(ModManager.mods.values()).find(m => m.name === "Mod Hub");
          if (existing) {
            ModManager.disableMod(existing.id);
          }
        } catch (e) {}

        const reg = ModManager.installBuiltInMod("Mod Hub", "2.4.0", code);
        ModManager.enableMod(reg.id);
        console.log("Mod Hub script installed and enabled successfully via ModManager.");
      } else {
        // Fallback to window.eval if ModManager is not available
        if (typeof registerMod !== 'undefined' && !window.registerMod) {
          window.registerMod = registerMod;
        }
        (window.execScript || window.eval)(code);
        console.log("Mod Hub script evaluated successfully via eval fallback.");
      }
    })
    .catch((error) => {
      console.error("Failed to load Mod Hub script:", error);
      alert("Failed to load Mod Hub: " + error.message);
    });
})();
