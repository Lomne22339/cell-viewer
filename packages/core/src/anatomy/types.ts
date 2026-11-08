/**
 * An anatomical figure divided into named, data-addressable regions.
 *
 * A model is pure data — SVG path strings and labels — so it lives in core,
 * is validated by unit tests, and can be rendered by any front end. Adding an
 * organ is adding one of these and registering it; nothing in the view,
 * matching or selection code knows which organs exist.
 */
export interface OrganSegment {
  /** Stable id, unique within the model. Used in URLs, tests and the DOM. */
  id: string;
  /** Human-readable name shown on hover and in the breadcrumb. */
  label: string;
  /**
   * Labels a dataset might use for this region. Matching is done on a
   * normalised form (see `normalizeLabel`), so case, punctuation and
   * underscores do not matter, but synonyms and abbreviations must be listed.
   */
  aliases: string[];
  /** SVG path data in the model's viewBox. May contain several subpaths. */
  path: string;
  /** Id of a more detailed model this segment opens on double-click. */
  drillDown?: string;
  /**
   * A structure seen through the surface (the hippocampus inside the temporal
   * lobe). Drawn on top with a dashed outline; it may overlap other segments.
   */
  deep?: boolean;
}

export interface OrganDecor {
  /**
   * `outline` is a silhouette edge, `vessel` a blood vessel or duct, `detail`
   * a sulcus, valve or other surface marking. Decor never captures clicks and
   * never takes part in statistics.
   */
  kind: 'outline' | 'vessel' | 'detail';
  path: string;
}

export interface OrganModel {
  id: string;
  label: string;
  /** The projection drawn, e.g. "anterior", "lateral (left)". */
  view: string;
  /** `[minX, minY, width, height]`, as for the SVG attribute. */
  viewBox: [number, number, number, number];
  /**
   * Field names worth preferring when several categorical fields match this
   * model equally well, most preferred first.
   */
  fieldHints?: string[];
  /**
   * Names of the organ itself (`liver`, `hepatic`), as opposed to its regions.
   *
   * They do two jobs. A qualified label such as `lung: left lobe` only reaches
   * a segment through its last part when the qualifier is one of these, so a
   * generic region name never borrows another organ's cells. And they let
   * `organScope` find the field (usually `tissue`) that says which cells belong
   * to this organ at all. A model of no single organ, like the whole body,
   * leaves this out, and then any qualifier is accepted.
   */
  organAliases?: string[];
  segments: OrganSegment[];
  decor?: OrganDecor[];
}
