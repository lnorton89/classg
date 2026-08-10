package capture

import "github.com/classg/api/internal/model"

func modelCapture(filename string) model.Capture {
	return model.Capture{CaptureID: "C1", Filename: filename, State: model.CaptureCompleted}
}
