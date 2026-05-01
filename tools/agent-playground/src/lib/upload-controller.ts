/**
 * Upload state machine. Plain TS (no runes) so it's directly testable.
 */

import { uploadFile, validateFile, type UploadStatus } from "./upload.ts";

export type UploadControllerStatus = "idle" | "uploading" | "converting" | "ready" | "error";

type UploadControllerOptions = {
  onchange: (artifactId: string | undefined) => void;
  onUpdate: () => void;
};

export function createUploadController(opts: UploadControllerOptions) {
  let _file: File | null = null;
  let _status: UploadControllerStatus = "idle";
  let _progress = 0;
  let _errorMessage: string | null = null;
  let _abortController: AbortController | null = null;

  function handleFile(selectedFile: File) {
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }

    const validation = validateFile(selectedFile);
    if (!validation.valid) {
      _file = selectedFile;
      _status = "error";
      _errorMessage = validation.error;
      opts.onUpdate();
      opts.onchange(undefined);
      return;
    }

    _file = selectedFile;
    _status = "uploading";
    _progress = 0;
    _errorMessage = null;

    const controller = new AbortController();
    _abortController = controller;
    opts.onUpdate();

    uploadFile(
      selectedFile,
      (loaded: number) => {
        _progress = loaded;
        opts.onUpdate();
      },
      controller.signal,
      (uploadStatus: UploadStatus) => {
        if (uploadStatus === "converting") {
          _status = "converting";
          opts.onUpdate();
        }
      },
    )
      .then((result: { artifactId: string } | { error: string }) => {
        if (_abortController !== controller) return;

        if ("artifactId" in result) {
          _status = "ready";
          opts.onUpdate();
          opts.onchange(result.artifactId);
        } else if (result.error !== "Upload cancelled") {
          _status = "error";
          _errorMessage = result.error;
          opts.onUpdate();
          opts.onchange(undefined);
        }
      })
      .catch(() => {
        if (_abortController !== controller) return;
        _status = "error";
        _errorMessage = "Unexpected upload error";
        opts.onUpdate();
        opts.onchange(undefined);
      });
  }

  function cancel() {
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }
    _file = null;
    _status = "idle";
    _progress = 0;
    _errorMessage = null;
    opts.onUpdate();
    opts.onchange(undefined);
  }

  function retry() {
    if (_file) {
      handleFile(_file);
    }
  }

  function destroy() {
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }
    if (_status !== "ready") {
      opts.onchange(undefined);
    }
  }

  return {
    get file() {
      return _file;
    },
    get status() {
      return _status;
    },
    get progress() {
      return _progress;
    },
    get errorMessage() {
      return _errorMessage;
    },
    get uploading() {
      return _status === "uploading" || _status === "converting";
    },
    get percentage() {
      return _file && _file.size > 0 ? Math.round((_progress / _file.size) * 100) : 0;
    },
    handleFile,
    cancel,
    retry,
    destroy,
  };
}
