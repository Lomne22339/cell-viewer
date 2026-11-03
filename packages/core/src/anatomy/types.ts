/** An anatomical figure divided into named, data-addressable regions (pure data). */
export interface OrganSegment {
  id: string;
  label: string;
  /** Dataset labels for this region, matched after normalization; list synonyms and abbreviations. */
  aliases: string[];
  path: string;
  drillDown?: string;
  deep?: boolean;
}

export interface OrganDecor {
  kind: 'outline' | 'vessel' | 'detail';
  path: string;
}

export interface OrganModel {
  id: string;
  label: string;
  view: string;
  /** `[minX, minY, width, height]`, as for the SVG attribute. */
  viewBox: [number, number, number, number];
  fieldHints?: string[];
  /** The organ's own names (`liver`, `hepatic`), not its regions; omit for a whole-body model. */
  organAliases?: string[];
  segments: OrganSegment[];
  decor?: OrganDecor[];
}
