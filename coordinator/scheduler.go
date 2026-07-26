// Copyright (c) 2024-2026 Soumya Debnath. All Rights Reserved.
// Licensed under the Business Source License 1.1 (BSL 1.1).
// See LICENSE file for details. Production use requires a paid license.
// Contact: soumyadebnath1661@gmail.com | +91 7031648617

package main

import (
	"github.com/gorilla/websocket"
)

type Client struct {
	conn     *websocket.Conn
	isMobile bool
}

type Scheduler struct {
	clients    map[*Client]bool
	register   chan *Client
	unregister chan *Client
	broadcast  chan Message
}

var scheduler = Scheduler{
	clients:    make(map[*Client]bool),
	register:   make(chan *Client),
	unregister: make(chan *Client),
	broadcast:  make(chan Message),
}

func (s *Scheduler) run() {
	for {
		select {
		case client := <-s.register:
			s.clients[client] = true
			s.broadcastWorkerCount()
		case client := <-s.unregister:
			if _, ok := s.clients[client]; ok {
				delete(s.clients, client)
				s.broadcastWorkerCount()
			}
		case message := <-s.broadcast:
			s.broadcastMessage(message)
		}
	}
}

func (s *Scheduler) broadcastWorkerCount() {
	count := 0
	for client := range s.clients {
		if !client.isMobile {
			count++
		}
	}
	msg := Message{Type: "worker_count", Count: count}
	s.broadcastMessage(msg)
}

func (s *Scheduler) broadcastMessage(msg Message) {
	for client := range s.clients {
		client.conn.WriteJSON(msg)
	}
}
