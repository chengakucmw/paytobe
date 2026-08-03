const menuButton = document.querySelector("[data-menu-button]");
const siteNav = document.querySelector("[data-site-nav]");

if (menuButton && siteNav) {
  const closeMenu = () => {
    menuButton.setAttribute("aria-expanded", "false");
    siteNav.classList.remove("open");
    document.body.classList.remove("menu-open");
  };

  menuButton.addEventListener("click", () => {
    const isOpen = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!isOpen));
    siteNav.classList.toggle("open", !isOpen);
    document.body.classList.toggle("menu-open", !isOpen);
  });

  siteNav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 940) closeMenu();
  });
}

document.querySelectorAll("[data-tabs]").forEach((tabSet) => {
  const tabs = [...tabSet.querySelectorAll('[role="tab"]')];
  const panels = tabs
    .map((tab) => document.getElementById(tab.getAttribute("aria-controls")))
    .filter(Boolean);

  const activate = (nextTab) => {
    tabs.forEach((tab) => {
      const selected = tab === nextTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.id !== nextTab.getAttribute("aria-controls");
    });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      activate(tabs[nextIndex]);
      tabs[nextIndex].focus();
    });
  });
});

document.querySelectorAll("[data-language-picker]").forEach((picker) => {
  picker.addEventListener("change", () => {
    window.location.href = picker.value;
  });
});

const pilotForm = document.querySelector("[data-pilot-form]");

if (pilotForm) {
  pilotForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!pilotForm.reportValidity()) return;

    const data = new FormData(pilotForm);
    const organization = String(data.get("organization") || "").trim();
    const email = String(data.get("email") || "").trim();
    const useCase = String(data.get("use_case") || "").trim();
    const integration = String(data.get("integration") || "").trim();
    const notes = String(data.get("notes") || "").trim();
    const copy = (key, fallback) => pilotForm.dataset[key] || fallback;
    const subject = `${copy("i18nSubject", "VelarumPay Preview pilot request")} — ${organization}`;
    const body = [
      copy("i18nSubject", "VelarumPay Preview pilot request"),
      "",
      `${copy("i18nOrganization", "Organization")}: ${organization}`,
      `${copy("i18nContact", "Contact")}: ${email}`,
      `${copy("i18nUseCase", "Use case")}: ${useCase}`,
      `${copy("i18nIntegration", "Preferred integration")}: ${integration}`,
      "",
      `${copy("i18nNotes", "Notes")}:`,
      notes || copy("i18nNoNotes", "No additional notes."),
      "",
      copy("i18nDisclaimer", "I understand that this is a Preview and pilot request, not live merchant approval.")
    ].join("\n");

    const status = pilotForm.querySelector("[data-form-status]");
    if (status) status.textContent = copy("i18nStatus", "Opening your email app. This website has not stored your answers.");
    window.location.href = `mailto:pilot@velarumpay.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });
}
