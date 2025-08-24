import type { Option, OptionMapItem } from "./types.ts";

export default class OptionMap extends Map<string, OptionMapItem> {
  public first?: OptionMapItem;

  constructor(options: Option[]) {
    super();

    let previousItem: OptionMapItem | undefined;

    for (const [index, option] of options.entries()) {
      const item: OptionMapItem = { ...option, index, previous: previousItem };

      if (previousItem) {
        previousItem.next = item;
      }

      if (index === 0) {
        this.first = item;
      }

      this.set(option.value, item);
      previousItem = item;
    }
  }
}
