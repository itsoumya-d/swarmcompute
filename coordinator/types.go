// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com

package main

type Task struct {
	ID        string      `json:"id"`
	Input     interface{} `json:"input"`
	TimeoutMs int         `json:"timeoutMs"`
	WasmModule string     `json:"wasmModule"`
}

type TaskResult struct {
	TaskID          string      `json:"taskId"`
	Result          interface{} `json:"result"`
	Error           string      `json:"error,omitempty"`
	ExecutionTimeMs int         `json:"executionTimeMs"`
}

type Message struct {
	Type     string      `json:"type"`
	IsMobile bool        `json:"isMobile,omitempty"`
	Task     *Task       `json:"task,omitempty"`
	Result   *TaskResult `json:"result,omitempty"`
	Count    int         `json:"count,omitempty"`
}
