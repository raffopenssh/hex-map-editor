package srv

import (
	"math/rand"
	"os"
)

func readFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

var editorAdjectives = []string{"Swift", "Quiet", "Bright", "Bold", "Calm", "Clever", "Gentle", "Wise", "Brave", "Kind", "Lively", "Noble", "Keen", "Merry", "Sunny"}
var editorAnimals = []string{"Heron", "Kob", "Egret", "Ibis", "Gazelle", "Buffalo", "Crane", "Stork", "Falcon", "Oryx", "Eland", "Lechwe", "Pelican", "Jackal", "Hornbill"}

func randomEditorName() string {
	return editorAdjectives[rand.Intn(len(editorAdjectives))] + " " + editorAnimals[rand.Intn(len(editorAnimals))]
}
