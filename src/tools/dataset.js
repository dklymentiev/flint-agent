// Dataset navigation tool — lets the model page through stored datasets

export const datasetToolDefs = [
  {
    type: "function",
    function: {
      name: "show_dataset",
      description: "Navigate to a specific page of a named dataset. Datasets are created when tools return large result sets. Check 'Active datasets' in your context for available IDs.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Dataset ID (e.g. ds_1)" },
          page: { type: "number", description: "Page number (1-based). Omit to go to next page." },
        },
        required: ["id"],
      },
    },
  },
];

export function createDatasetHandlers(store) {
  return {
    show_dataset({ id, page }) {
      const ds = store.getState().datasets[id];
      if (!ds) {
        const available = Object.values(store.getState().datasets)
          .map((d) => `${d.id} "${d.label}"`)
          .join(", ");
        return `Error: dataset "${id}" not found. Available: ${available || "none"}`;
      }

      const totalPages = Math.ceil(ds.rows.length / ds.pageSize);
      const target = page || ds.page + 1;
      const clamped = Math.max(1, Math.min(target, totalPages));
      store.getState().setDatasetPage(id, clamped);

      const start = (clamped - 1) * ds.pageSize;
      const pageRows = ds.rows.slice(start, start + ds.pageSize);

      return {
        _table: true,
        _pagination: true, // skip re-registration as new dataset
        columns: ds.columns,
        rows: pageRows,
        title: `${ds.label} (page ${clamped}/${totalPages}, ${ds.rows.length} total)`,
        name: ds.label,
      };
    },
  };
}
