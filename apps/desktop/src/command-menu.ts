import { completeCommand, filterCommands, type CommandSpec } from "@cooper/host/commands";

export function bindCommandMenu(
  prompt: HTMLTextAreaElement,
  menu: HTMLElement,
  commands: () => readonly CommandSpec[],
  onComplete: () => void,
) {
  let matches: CommandSpec[] = [];
  let selected = 0;
  let dismissed = false;
  let composing = false;

  function select(index: number): void {
    selected = index;
    for (const [position, option] of Array.from(menu.children).entries()) {
      option.setAttribute("aria-selected", String(position === selected));
    }
    const option = menu.children[selected];
    if (option) {
      prompt.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
  }

  function refresh(): void {
    const prefix = prompt.value.trimStart();
    const visible = !dismissed && !composing && !prompt.disabled && !prompt.readOnly &&
      document.activeElement === prompt && /^\/\S*$/.test(prefix);
    matches = visible ? filterCommands(prompt.value, commands()) : [];
    menu.hidden = matches.length === 0;
    if (menu.hidden) {
      prompt.removeAttribute("aria-activedescendant");
      menu.replaceChildren();
      return;
    }
    menu.replaceChildren(...matches.map((spec, index) => {
      const option = document.createElement("div");
      option.id = `command-option-${spec.name}`;
      option.setAttribute("role", "option");
      const usage = document.createElement("code");
      usage.textContent = spec.usage;
      const description = document.createElement("span");
      description.textContent = spec.description;
      option.append(usage, description);
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => complete(index));
      return option;
    }));
    select(Math.min(selected, matches.length - 1));
  }

  function dismiss(): void {
    dismissed = true;
    refresh();
  }

  function complete(index: number): void {
    const spec = matches[index];
    if (!spec) return;
    prompt.value = completeCommand(prompt.value, spec);
    dismiss();
    onComplete();
  }

  prompt.addEventListener("focus", refresh);
  prompt.addEventListener("blur", refresh);
  prompt.addEventListener("input", () => {
    selected = 0;
    dismissed = false;
    refresh();
  });
  prompt.addEventListener("compositionstart", () => {
    composing = true;
    refresh();
  });
  prompt.addEventListener("compositionend", () => {
    composing = false;
    refresh();
  });

  return {
    refresh,
    dismiss,
    handleKey(event: KeyboardEvent): boolean {
      if (menu.hidden || composing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      switch (event.key) {
        case "ArrowUp":
          select(Math.max(0, selected - 1));
          break;
        case "ArrowDown":
          select(Math.min(matches.length - 1, selected + 1));
          break;
        case "Tab":
        case "Enter":
          if (!event.repeat) complete(selected);
          break;
        case "Escape":
          dismiss();
          break;
        default:
          return false;
      }
      event.preventDefault();
      return true;
    },
  };
}
