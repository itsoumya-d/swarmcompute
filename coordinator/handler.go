package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	defer conn.Close()

	var isMobile bool
	_, p, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var msg Message
	if err := json.Unmarshal(p, &msg); err == nil && msg.Type == "register" {
		isMobile = msg.IsMobile
	}

	client := &Client{conn: conn, isMobile: isMobile}
	scheduler.register <- client
	defer func() {
		scheduler.unregister <- client
	}()

	for {
		_, p, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var m Message
		if err := json.Unmarshal(p, &m); err != nil {
			continue
		}
		
		if m.Type == "submit_task" && m.Task != nil {
			scheduler.broadcast <- m
		} else if m.Type == "task_result" && m.Result != nil {
			scheduler.broadcast <- m
		}
	}
}
