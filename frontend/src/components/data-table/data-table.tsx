"use client";

/**
 * The one table of the app, driven by TanStack Table v9: sortable headers, an
 * optional search box and client-side pages. A list is normally loaded whole,
 * so all three work on the rows in memory.
 *
 *   const helper = createDataColumnHelper<Student>();
 *   const columns = helper.columns([
 *     helper.accessor("login_id", { header: "Student ID", sortFn: "alphanumeric", enableGlobalFilter: true }),
 *     helper.display({ id: "actions", header: "Actions", cell: ({ row }) => … }),
 *   ]);
 *
 *   <DataTable label="Students" data={students} columns={columns}
 *     getRowId={(s) => String(s.id)} search={{ label: "Search students" }}
 *     loadingText="Loading students…" emptyText="No students yet." />
 *
 * Columns are sortable unless they set `enableSorting: false`, and searched
 * only when they set `enableGlobalFilter: true`. Keep `columns` at module
 * scope or in a memo: a new array on every render rebuilds the row models.
 *
 * A list too long to load whole (the operation log) passes `serverPages`
 * instead: `data` is then one page that the caller fetched, the page controls
 * report through `onChange`, and the headers do not sort, because the server
 * decides the order. Leave `search` out there and filter in the request.
 *
 *   <DataTable … data={page?.items ?? null}
 *     serverPages={{ total: page?.total ?? 0, pageIndex, pageSize, onChange: setPaging }} />
 */

import { useId, useState, type ReactNode } from "react";
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  metaHelper,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type ColumnMeta = {
  /** Right-aligns the header and its cells (numbers). */
  align?: "right";
  /** Extra classes for the body cells of this column. */
  cellClassName?: string;
};

// Module scope on purpose: the feature registry must keep its identity
const features = tableFeatures({
  columnMeta: metaHelper<ColumnMeta>(),
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowPaginationFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    text: sortFn_text,
  },
});

// The cell value type differs per column, so a column list can only be typed with `any` there
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataTableColumn<TData extends RowData> = ColumnDef<typeof features, TData, any>;

/** Column helper bound to the features above, so sort and filter names are typed. */
export function createDataColumnHelper<TData extends RowData>() {
  return createColumnHelper<typeof features, TData>();
}

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;
// A stable stand-in while loading: a fresh [] each render would rebuild the row models
const NO_ROWS: never[] = [];

/** Paging done by the server: `data` holds only the current page. */
export type ServerPages = {
  /** Rows over all pages. */
  total: number;
  /** 0-based. */
  pageIndex: number;
  pageSize: number;
  /** The reader asked for another page or page size: fetch it. */
  onChange: (next: PaginationState) => void;
};

type DataTableProps<TData extends RowData> = {
  /** Accessible name of the table. */
  label: string;
  /** null while the list is loading (or failed to load). */
  data: TData[] | null;
  columns: DataTableColumn<TData>[];
  getRowId: (row: TData) => string;
  /** Shown instead of rows while `data` is null. */
  loadingText: string;
  /** Shown when the list is loaded and has no rows. */
  emptyText: string;
  /** Shown when the search matches nothing. */
  noMatchText?: string;
  /** Adds the search box. It looks in columns with `enableGlobalFilter: true`. */
  search?: { label: string; placeholder?: string };
  /** Controls the search text from outside (both or neither). */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Text beside the search box for the number of rows after searching. */
  count?: (rows: number) => string;
  /** false shows every row and no page controls. */
  paginate?: boolean;
  /** The caller fetches each page (see the file header). Turns sorting off. */
  serverPages?: ServerPages;
  /** "card": bordered card with padded edges. "plain": no frame, for use inside a card. */
  variant?: "card" | "plain";
  /** Classes for the <table>, e.g. a min width so it scrolls sideways on phones. */
  className?: string;
};

export function DataTable<TData extends RowData>({
  label,
  data,
  columns,
  getRowId,
  loadingText,
  emptyText,
  noMatchText = "Nothing matches your search.",
  search,
  query,
  onQueryChange,
  count,
  paginate = true,
  serverPages,
  variant = "card",
  className,
}: DataTableProps<TData>) {
  const searchId = useId();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [ownQuery, setOwnQuery] = useState("");
  const [ownPagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: paginate ? DEFAULT_PAGE_SIZE : Infinity,
  });
  const pagination: PaginationState = serverPages
    ? { pageIndex: serverPages.pageIndex, pageSize: serverPages.pageSize }
    : ownPagination;

  const globalFilter = query ?? ownQuery;
  const toFirstPage = () =>
    setPagination((current) =>
      current.pageIndex === 0 ? current : { ...current, pageIndex: 0 },
    );

  const table = useTable({
    features,
    data: data ?? NO_ROWS,
    columns,
    getRowId,
    // Trimmed so a stray space around the search text does not hide every row
    state: { sorting, globalFilter: globalFilter.trim(), pagination },
    defaultColumn: { enableGlobalFilter: false },
    globalFilterFn: "includesString",
    sortDescFirst: false,
    onSortingChange: (updater) => {
      setSorting(updater);
      toFirstPage();
    },
    onPaginationChange: serverPages
      ? (updater) =>
          serverPages.onChange(
            typeof updater === "function" ? updater(pagination) : updater,
          )
      : setPagination,
    // Server pages: `data` is already the right slice, in the server's order
    manualPagination: !!serverPages,
    rowCount: serverPages?.total,
    enableSorting: !serverPages,
    // The automatic reset also fires when the rows are fetched again (after an
    // edit, or a status poll), which would throw the reader back to page 1.
    // Sorting and searching go to the first page by hand instead.
    autoResetPageIndex: false,
  });

  function changeQuery(value: string) {
    if (onQueryChange) onQueryChange(value);
    else setOwnQuery(value);
    toFirstPage();
  }

  const rows = table.getRowModel().rows;
  const matched = table.getRowCount();
  const pageCount = table.getPageCount();
  // The list shrank (or an outside reset cleared the search) under a later
  // page: step back to the last one that still has rows
  // (with server pages the caller does this, when a fetch comes back empty)
  if (!serverPages && pagination.pageIndex > 0 && pagination.pageIndex >= pageCount) {
    setPagination({ ...pagination, pageIndex: Math.max(0, pageCount - 1) });
  }

  const plain = variant === "plain";
  const edge = plain ? "first:pl-0 last:pr-0" : "first:pl-4 last:pr-4";
  const message =
    data === null
      ? loadingText
      : data.length === 0
        ? emptyText
        : matched === 0
          ? noMatchText
          : null;
  // Small lists keep the plain look: no page controls until they are needed
  const showPages =
    paginate && data !== null && (serverPages?.total ?? data.length) > PAGE_SIZES[0];
  const firstRow = pagination.pageIndex * pagination.pageSize + 1;

  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      {search && (
        <div className="flex items-center gap-3">
          <Label htmlFor={searchId} className="sr-only">
            {search.label}
          </Label>
          <Input
            id={searchId}
            type="search"
            autoComplete="off"
            value={globalFilter}
            onChange={(event) => changeQuery(event.target.value)}
            placeholder={search.placeholder ?? search.label}
            className="h-10 bg-card"
          />
          {count && (
            <span role="status" className="shrink-0 text-muted-foreground">
              {data !== null && count(matched)}
            </span>
          )}
        </div>
      )}

      <div className={cn(!plain && "overflow-hidden rounded-xl border bg-card")}>
        <Table aria-label={label} className={className}>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const { column } = header;
                  const sorted = column.getIsSorted();
                  const right = column.columnDef.meta?.align === "right";
                  const content = header.isPlaceholder ? null : (
                    <table.FlexRender header={header} />
                  );
                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      aria-sort={
                        !column.getCanSort()
                          ? undefined
                          : sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : "none"
                      }
                      className={cn(
                        "h-auto px-3 py-2.5 text-xs text-muted-foreground",
                        edge,
                        right && "text-right",
                      )}
                    >
                      {column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={column.getToggleSortingHandler()}
                          className={cn(
                            "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 font-medium outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                            sorted && "text-foreground",
                          )}
                        >
                          {content}
                          {sorted === "asc" ? (
                            <ArrowUpIcon aria-hidden="true" className="size-3" />
                          ) : sorted === "desc" ? (
                            <ArrowDownIcon aria-hidden="true" className="size-3" />
                          ) : (
                            <ChevronsUpDownIcon aria-hidden="true" className="size-3 opacity-50" />
                          )}
                        </button>
                      ) : (
                        content
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {message !== null && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={columns.length}
                  role={data === null ? "status" : undefined}
                  className="px-4 py-8 text-center whitespace-normal text-muted-foreground"
                >
                  {message}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.id}>
                {row.getAllCells().map((cell) => {
                  const meta = cell.column.columnDef.meta;
                  return (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        "px-3 whitespace-normal",
                        plain ? "py-2.5" : "py-3",
                        edge,
                        meta?.align === "right" && "text-right tabular-nums",
                        meta?.cellClassName,
                      )}
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {showPages && (
        <PageControls
          sizeLabel={`${label}: rows per page`}
          pageSize={pagination.pageSize}
          onPageSize={(size) => table.setPageSize(size)}
          summary={
            matched === 0
              ? "0 rows"
              : `${firstRow}–${firstRow + rows.length - 1} of ${matched}`
          }
          onPrevious={table.getCanPreviousPage() ? () => table.previousPage() : null}
          onNext={table.getCanNextPage() ? () => table.nextPage() : null}
        />
      )}
    </div>
  );
}

function PageControls({
  sizeLabel,
  pageSize,
  onPageSize,
  summary,
  onPrevious,
  onNext,
}: {
  sizeLabel: string;
  pageSize: number;
  onPageSize: (size: number) => void;
  summary: ReactNode;
  /** null when there is no such page. */
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-muted-foreground">
      <label className="flex items-center gap-2">
        Rows per page
        <Select
          value={pageSize}
          onValueChange={(size) => {
            if (size != null) onPageSize(size);
          }}
        >
          <SelectTrigger size="sm" aria-label={sizeLabel} className="text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-0">
            {PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={size}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <div className="flex items-center gap-2">
        <span role="status" className="tabular-nums">
          {summary}
        </span>
        <Button variant="outline" size="sm" disabled={!onPrevious} onClick={() => onPrevious?.()}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!onNext} onClick={() => onNext?.()}>
          Next
        </Button>
      </div>
    </div>
  );
}
