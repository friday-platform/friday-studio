package main

import (
	"testing"
)

func TestConfigValidate(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		wantErr string
	}{
		{
			name:    "missing project_id",
			cfg:     Config{},
			wantErr: "project_id is required",
		},
		{
			name: "missing dataset_id",
			cfg: Config{
				ProjectID: "test-project",
			},
			wantErr: "dataset_id is required",
		},
		{
			name: "missing table_id",
			cfg: Config{
				ProjectID: "test-project",
				DatasetID: "test-dataset",
			},
			wantErr: "table_id is required",
		},
		{
			name: "valid config",
			cfg: Config{
				ProjectID: "test-project",
				DatasetID: "test-dataset",
				TableID:   "test-table",
			},
			wantErr: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("Validate() error = %v, want nil", err)
				}
			} else {
				if err == nil {
					t.Errorf("Validate() error = nil, want %q", tt.wantErr)
				} else if err.Error() != tt.wantErr {
					t.Errorf("Validate() error = %q, want %q", err.Error(), tt.wantErr)
				}
			}
		})
	}
}
