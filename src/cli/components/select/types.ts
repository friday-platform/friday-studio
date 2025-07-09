export interface Option {
  label: string;
  value: string;
}

export interface OptionMapItem extends Option {
  index: number;
  previous?: OptionMapItem;
  next?: OptionMapItem;
}
