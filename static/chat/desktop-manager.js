(function attachAgentoCDesktopManager(root) {
  "use strict";

  const body = root.document?.body;
  if (!body?.classList.contains("desktop-manager")) return;

  const doc = root.document;
  const nav = doc.getElementById("desktopManagerNav");
  const buttons = [...(nav?.querySelectorAll("[data-desktop-manager-tab]") || [])];
  const heading = doc.getElementById("desktopManagerPageHeading");
  const headingTitle = doc.getElementById("desktopManagerPageTitle");
  const headingDescription = doc.getElementById("desktopManagerPageDescription");
  const subpageHeader = doc.getElementById("sidebarSubpageHeader");
  const backButton = doc.getElementById("sidebarSubpageCloseBtn");
  const pairingPanel = doc.getElementById("desktopManagerPairingPanel");
  const pairingButton = doc.getElementById("desktopManagerStartPairingBtn");
  const externalStatus = doc.getElementById("desktopManagerExternalStatus");
  const settingsPanels = [
    "settingsPanel",
    "modelProvidersPanel",
    "harnessesPanel",
    "accountPolicyPanel",
  ].map((id) => doc.getElementById(id)).filter(Boolean);
  const pageCopy = {
    account: [
      "desktopManager.page.account.title",
      "desktopManager.page.account.description",
      "Accounts & permissions",
      "Manage Google Owner sign-in, trusted devices, and execution permissions.",
    ],
    harnesses: [
      "desktopManager.page.harnesses.title",
      "desktopManager.page.harnesses.description",
      "Harness management",
      "Install, update, or remove AgentoC runtimes on this computer.",
    ],
    providers: [
      "desktopManager.page.providers.title",
      "desktopManager.page.providers.description",
      "Model providers",
      "Manage provider accounts and API gateways for this workbench.",
    ],
    pairing: [
      "desktopManager.page.pairing.title",
      "desktopManager.page.pairing.description",
      "Phone pairing",
      "Connect an Android phone securely to this computer.",
    ],
  };

  function translate(key, fallback) {
    const value = root.agentocT?.(key);
    return value && value !== key ? value : fallback;
  }

  function select(name) {
    for (const button of buttons) {
      if (button.dataset.desktopManagerTab === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    body.dataset.desktopManagerTab = name;
  }

  function updatePageHeading(name) {
    const [titleKey, descriptionKey, titleFallback, descriptionFallback] = pageCopy[name] || pageCopy.account;
    const title = translate(titleKey, titleFallback);
    if (headingTitle) headingTitle.textContent = title;
    if (headingDescription) headingDescription.textContent = translate(descriptionKey, descriptionFallback);
    if (heading) heading.hidden = false;
    doc.title = `AgentoC · ${title}`;
  }

  function hideSubpageHeader() {
    if (subpageHeader) subpageHeader.hidden = true;
  }

  function switchTo(tab, managerName) {
    if (pairingPanel) {
      pairingPanel.hidden = true;
      pairingPanel.classList.remove("visible");
    }
    if (typeof root.switchTab === "function") root.switchTab(tab, { animate: false });
    hideSubpageHeader();
    select(managerName);
    updatePageHeading(managerName);
    if (managerName === "account") root.AgentoCCrossDevicePanel?.refreshManager?.();
  }

  function showPairingPage() {
    if (typeof root.switchTab === "function") root.switchTab("settings", { animate: false });
    for (const panel of settingsPanels) {
      panel.hidden = true;
      panel.classList.remove("visible");
    }
    if (pairingPanel) {
      pairingPanel.hidden = false;
      pairingPanel.classList.add("visible");
    }
    hideSubpageHeader();
    select("pairing");
    updatePageHeading("pairing");
  }

  function showAccount() {
    switchTo("settings", "account");
  }

  function openPairing() {
    select("pairing");
    updatePageHeading("pairing");
    root.AgentoCCrossDevicePanel?.open?.({ view: "register" });
  }

  doc.querySelector(".desktop-manager-account-group")?.removeAttribute("hidden");
  doc.querySelector(".desktop-manager-devices-group")?.removeAttribute("hidden");
  doc.getElementById("desktopManagerHeader")?.removeAttribute("hidden");
  nav?.removeAttribute("hidden");
  root.AgentoCDesktopManager = Object.freeze({ showAccount, openPairing });
  root.agentocDesktop?.onExternalOpenFailed?.(() => {
    if (!externalStatus) return;
    externalStatus.textContent = translate(
      "desktopManager.externalOpenFailed",
      "Could not open the sign-in page in your browser.",
    );
    externalStatus.hidden = false;
  });

  nav?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-desktop-manager-tab]");
    if (!button || !nav.contains(button)) return;
    switch (button.dataset.desktopManagerTab) {
      case "account": showAccount(); break;
      case "harnesses": switchTo("harnesses", "harnesses"); break;
      case "providers": switchTo("model-providers", "providers"); break;
      case "pairing": showPairingPage(); break;
    }
  });

  pairingButton?.addEventListener("click", openPairing);
  doc.getElementById("accountPolicyOpenBtn")?.addEventListener("click", () => {
    if (heading) heading.hidden = true;
    select("account");
  }, true);

  // The shared WebUI returns to Sessions when closing a subpage. The manager
  // has no chat surface, so its back affordance always returns to its account
  // landing panel instead.
  backButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    showAccount();
  }, true);

  const activeTab = typeof root.getActiveSidebarTabValue === "function"
    ? root.getActiveSidebarTabValue()
    : "settings";
  if (activeTab === "harnesses") switchTo("harnesses", "harnesses");
  else if (activeTab === "model-providers") switchTo("model-providers", "providers");
  else if (activeTab === "account-policy") {
    root.switchTab?.("account-policy", { animate: false });
    select("account");
    if (heading) heading.hidden = true;
  } else showAccount();
})(window);
