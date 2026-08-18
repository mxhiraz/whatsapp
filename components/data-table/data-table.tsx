'use client'

import { useState } from 'react'
import {
  useTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type PaginationState,
  type RowData,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowsDownUp, CaretLeft, CaretRight, MagnifyingGlass } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tip } from '@/components/shared'
import { features, type TableFeatures } from '@/components/data-table/features'

/**
 * A sortable column header.
 *
 * Sorting is a button rather than a click anywhere on the header so that any
 * tooltip explaining the column stays reachable, and so keyboard users get a real
 * control. `tooltip` is optional: a column headed Name or Sent explains itself, and
 * hover text repeating the heading is noise.
 */
export function SortableHeader<TData extends RowData>({
  column,
  title,
  tooltip,
  align = 'left',
}: {
  column: Column<TableFeatures, TData>
  title: string
  tooltip?: string
  align?: 'left' | 'right'
}) {
  const sorted = column.getIsSorted()
  const button = (
    <Button
      variant="ghost"
      size="sm"
      className="-mx-2 h-7 px-2 font-medium"
      onClick={() => column.toggleSorting(sorted === 'asc')}
    >
      {title}
      {sorted === 'asc' ? <ArrowUp /> : sorted === 'desc' ? <ArrowDown /> : <ArrowsDownUp className="opacity-40" />}
    </Button>
  )
  return (
    <div className={align === 'right' ? 'flex justify-end' : undefined}>
      {tooltip ? (
        <Tip asChild tooltip={tooltip}>
          {button}
        </Tip>
      ) : (
        button
      )}
    </div>
  )
}

/** A plain, non-sortable header that still carries its explanation. */
export function PlainHeader({ title, tooltip, align = 'left' }: { title: string; tooltip?: string; align?: 'left' | 'right' }) {
  const label = tooltip ? <Tip tooltip={tooltip}>{title}</Tip> : title
  return <div className={align === 'right' ? 'text-right' : undefined}>{label}</div>
}

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<TableFeatures, TData>[]
  data: TData[]
  /** Column id to point the search box at. Omit to hide the search box. */
  searchColumn?: string
  searchPlaceholder?: string
  /** Rows become clickable when set, for tables that open a detail page. */
  onRowClick?: (row: TData) => void
  /** Shown in place of the body when there is nothing to list. */
  empty?: React.ReactNode
  /** Pagination only appears once the data is longer than this. */
  pageSize?: number
}

/**
 * The one table component in this app.
 *
 * Sorting, filtering and pagination are the same everywhere, so they live here
 * rather than being re-implemented per screen. The toolbar and the pagination row
 * hide themselves when they would be pointless (no search column, or fewer rows
 * than one page), which keeps small tables uncluttered without needing a second
 * component for them.
 *
 * There is no show/hide columns menu on purpose. A narrow screen is answered by
 * each column's own `meta.className` (`hidden sm:table-cell` and friends), so the
 * table decides what it can afford to show at each width instead of asking.
 */
export function DataTable<TData extends RowData>({
  columns,
  data,
  searchColumn,
  searchPlaceholder = 'Search',
  onRowClick,
  empty,
  pageSize = 25,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  // v9 removed `table.getState()`, so the page has to be held here to be read back.
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize })

  const table = useTable({
    features,
    data,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
      onPaginationChange: setPagination,
    state: { sorting, columnFilters, pagination },
  })

  const rows = table.getRowModel().rows
  const paginated = data.length > pageSize

  return (
    <div className="space-y-3">
      {searchColumn ? (
        <div className="flex items-center gap-2 pb-1">
          {searchColumn ? (
            <InputGroup className="sm:max-w-xs">
              <InputGroupAddon>
                <MagnifyingGlass />
              </InputGroupAddon>
              <InputGroupInput
                placeholder={searchPlaceholder}
                value={(table.getColumn(searchColumn)?.getFilterValue() as string) ?? ''}
                onChange={e => table.getColumn(searchColumn)?.setFilterValue(e.target.value)}
              />
            </InputGroup>
          ) : null}
        </div>
      ) : null}

      <Table>
        <TableHeader>
          {table.getHeaderGroups().map(group => (
            <TableRow key={group.id}>
              {group.headers.map(header => (
                <TableHead key={header.id} className={header.column.columnDef.meta?.className}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.map(row => (
            <TableRow
              key={row.id}
              className={onRowClick ? 'cursor-pointer' : undefined}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            >
              {row.getVisibleCells().map(cell => (
                <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {rows.length === 0 ? empty : null}

      {paginated ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {table.getFilteredRowModel().rows.length} of {data.length} rows
          </span>
          {/*
            The structural parts of shadcn's `Pagination` with real buttons inside.
            `PaginationLink` renders an anchor, which suits URL-driven paging; this
            table pages in memory, and an anchor without an href is neither
            focusable nor announced as a control.
          */}
          <Pagination className="mx-0 w-auto">
            <PaginationContent>
              <PaginationItem>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  <CaretLeft /> Previous
                </Button>
              </PaginationItem>
              <PaginationItem>
                <span className="text-muted-foreground px-2 text-xs tabular-nums">
                  Page {pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
                </span>
              </PaginationItem>
              <PaginationItem>
                <Button variant="ghost" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
                  Next <CaretRight />
                </Button>
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      ) : null}
    </div>
  )
}
