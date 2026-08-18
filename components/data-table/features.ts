import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  metaHelper,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
} from '@tanstack/react-table'

/**
 * The table behaviour this app opts into.
 *
 * TanStack Table v9 is feature-based: anything not registered here is tree-shaken
 * out of the bundle, including the built-in filter and sort functions. One shared
 * object keeps every table in the app on the same feature set, so a column written
 * for one table behaves identically in another.
 */
export const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  /**
   * Per-column classes, which is how a table answers a narrow screen. There is
   * deliberately no column-visibility menu, so a column that does not earn its
   * width on a phone hides itself with `hidden sm:table-cell` here and comes back
   * at the breakpoint where it fits.
   */
  columnMeta: metaHelper<ColumnMeta>(),
})

/** Applied to a column's header cell and to every body cell in that column. */
export interface ColumnMeta {
  className?: string
}

/** Pass as the first generic to `ColumnDef`, `Column`, `Table` and `Row`. */
export type TableFeatures = typeof features

