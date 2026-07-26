package main

import (
	"log"
	"net/http"
)

func main() {
	go scheduler.run()

	http.HandleFunc("/ws", handleWebSocket)

	log.Println("Coordinator starting on :8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}
