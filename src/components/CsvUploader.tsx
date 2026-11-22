import React, { useRef, useState } from 'react';
import Papa from 'papaparse';
import { UploadCloud, Database, AlertCircle } from 'lucide-react';
import { Dataset } from '../types';
import { inferDatasetSchema, describeUploadAdjustments, PREBUILT_DATASETS } from '../services/sampleData';

interface CsvUploaderProps {
  onDatasetLoaded: (dataset: Dataset, notice?: string) => void;
  isDarkMode: boolean;
}

export const CsvUploader: React.FC<CsvUploaderProps> = ({ onDatasetLoaded, isDarkMode }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = (file: File) => {
    if (!file) return;
    // Parsing is asynchronous, and a second drop while the first is in flight would leave two
    // readers competing to set the dataset.
    if (isLoading) return;
    setError(null);
    setIsLoading(true);

    const isCsvOrTsv = file.name.endsWith('.csv') || file.name.endsWith('.tsv') || file.name.endsWith('.txt');
    const isJson = file.name.endsWith('.json');

    if (!isCsvOrTsv && !isJson) {
      setError('Please upload a valid .csv, .tsv, or .json file.');
      setIsLoading(false);
      return;
    }

    const reader = new FileReader();

    if (isJson) {
      reader.onload = (e) => {
        try {
          const content = e.target?.result as string;
          const parsed = JSON.parse(content);
          const records = Array.isArray(parsed) ? parsed : [parsed];
          const rawName = file.name.replace(/\.[^/.]+$/, '');
          const tableName = rawName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
          const dataset = inferDatasetSchema(records, tableName, rawName);
          dataset.fileSizeFormatted = `${(file.size / 1024).toFixed(1)} KB`;
          onDatasetLoaded(dataset, describeUploadAdjustments(records, [], rawName) || undefined);
        } catch (err: any) {
          setError(`JSON Parse error: ${err?.message || 'Invalid JSON format'}`);
        } finally {
          setIsLoading(false);
        }
      };
      reader.readAsText(file);
    } else {
      // CSV / TSV Parsing
      Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: (results) => {
          setIsLoading(false);
          if (results.errors && results.errors.length > 0 && results.data.length === 0) {
            setError(`CSV Parsing Error: ${results.errors[0].message}`);
            return;
          }

          const rawName = file.name.replace(/\.[^/.]+$/, '');
          const tableName = rawName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
          const rows = results.data as Record<string, any>[];
          const dataset = inferDatasetSchema(rows, tableName, rawName);
          dataset.fileSizeFormatted = `${(file.size / 1024).toFixed(1)} KB`;
          onDatasetLoaded(dataset, describeUploadAdjustments(rows, results.errors, rawName) || undefined);
        },
        error: (err) => {
          setIsLoading(false);
          setError(`File reading failed: ${err.message}`);
        },
      });
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const loadSample = (key: 'saas' | 'ecommerce') => {
    const sample = PREBUILT_DATASETS[key];
    if (sample) {
      onDatasetLoaded(sample.dataset);
    }
  };

  const borderClass = isDragging
    ? 'border-accent bg-badge-accent-bg'
    : 'border-field-border bg-surface-secondary/40 hover:border-accent hover:bg-surface-secondary/70';

  return (
    <div className="w-full space-y-4">
      {/* Drag & Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => {
          if (isLoading) return;
          fileInputRef.current?.click();
        }}
        aria-busy={isLoading}
        className={`relative border-2 border-dashed rounded-2xl p-8 transition-all duration-fast cursor-pointer text-center group ${borderClass}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv,.json,.txt"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              handleFile(e.target.files[0]);
            }
          }}
        />

        <div className="flex flex-col items-center justify-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-badge-accent-bg text-badge-accent-fg border border-badge-accent-border flex items-center justify-center transition-transform duration-fast group-hover:scale-105 shadow-2xs">
            {isLoading ? (
              <div role="status" className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin">
                <span className="sr-only">Parsing dataset</span>
              </div>
            ) : (
              <UploadCloud className="w-7 h-7 text-accent" />
            )}
          </div>

          <div>
            <p className="text-sm font-semibold text-text-primary">
              Drop your CSV, TSV, or JSON dataset here, or{' '}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
                disabled={isLoading}
                aria-label="Browse for a dataset file"
                className="text-accent underline cursor-pointer rounded focus-ring disabled:text-text-muted disabled:no-underline disabled:cursor-not-allowed"
              >
                browse
              </button>
            </p>
            <p className="text-prose text-text-muted mt-1">
              Rows stay in this browser · DuckDB-WASM engine · your question plus column names,
              types and aggregate statistics go only to the AI provider you configure
            </p>
          </div>
        </div>

        {error && (
          <div role="alert" className="mt-4 p-2.5 rounded-lg bg-badge-error-bg border border-badge-error-border text-badge-error-fg text-xs flex items-center justify-center gap-2 shadow-2xs">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Instant Demo Datasets Picker */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 rounded-xl border border-border-subtle bg-surface-secondary/60">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Database className="w-4 h-4 text-accent" />
          <span>Don't have a dataset ready? Explore instant demo datasets:</span>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => loadSample('saas')}
            className="btn-interactive flex-1 sm:flex-initial text-xs font-medium px-3 py-1.5 rounded-lg border border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong hover:bg-surface-elevated flex items-center justify-center gap-1.5 shadow-2xs focus-ring"
          >
            <span>SaaS Retention & MRR</span>
            <span className="text-meta font-mono text-text-muted">(25 rows)</span>
          </button>

          <button
            type="button"
            onClick={() => loadSample('ecommerce')}
            className="btn-interactive flex-1 sm:flex-initial text-xs font-medium px-3 py-1.5 rounded-lg border border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong hover:bg-surface-elevated flex items-center justify-center gap-1.5 shadow-2xs focus-ring"
          >
            <span>E-Commerce Profitability</span>
            <span className="text-meta font-mono text-text-muted">(15 rows)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
