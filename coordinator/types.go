package main

type Task struct {
	ID        string      `json:"id"`
	Input     interface{} `json:"input"`
	TimeoutMs int         `json:"timeoutMs"`
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
