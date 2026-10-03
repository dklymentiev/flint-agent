// Dataset slice — named datasets with pagination
// Stores structured data from tool results, survives context compression

const MAX_DATASETS = 10;

export function createDatasetSlice(set, get) {
  return {
    datasets: {},
    _datasetSeq: 1,

    addDataset({ label, columns, rows, pageSize = 10, source }) {
      const id = `ds_${get()._datasetSeq}`;
      const datasets = { ...get().datasets };

      // Evict oldest if at capacity
      const keys = Object.keys(datasets);
      if (keys.length >= MAX_DATASETS) {
        let oldest = keys[0];
        for (const k of keys) {
          if (datasets[k].createdAt < datasets[oldest].createdAt) oldest = k;
        }
        delete datasets[oldest];
      }

      datasets[id] = {
        id,
        label: label || "data",
        columns,
        rows,
        page: 1,
        pageSize,
        source: source || "unknown",
        createdAt: Date.now(),
      };

      set({ datasets, _datasetSeq: get()._datasetSeq + 1 });
      return id;
    },

    setDatasetPage(id, page) {
      const ds = get().datasets[id];
      if (!ds) return;
      const totalPages = Math.ceil(ds.rows.length / ds.pageSize);
      const clamped = Math.max(1, Math.min(page, totalPages));
      set({
        datasets: {
          ...get().datasets,
          [id]: { ...ds, page: clamped },
        },
      });
    },

    getDatasetPage(id) {
      const ds = get().datasets[id];
      if (!ds) return null;
      const totalPages = Math.ceil(ds.rows.length / ds.pageSize);
      const start = (ds.page - 1) * ds.pageSize;
      return {
        id: ds.id,
        label: ds.label,
        columns: ds.columns,
        rows: ds.rows.slice(start, start + ds.pageSize),
        page: ds.page,
        totalPages,
        totalRows: ds.rows.length,
      };
    },

    clearDatasets() {
      set({ datasets: {} });
    },
  };
}
