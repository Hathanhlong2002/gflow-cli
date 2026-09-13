export function validCreativePlan() {
  return {
    schemaVersion: 1 as const,
    topic: "Những bí ẩn của đại dương",
    language: "vi-VN",
    seriesTitle: "Bên dưới mặt nước",
    seriesPremise: "Mười chuyến lặn khám phá những bí ẩn độc lập.",
    continuity: {
      characters: ["Linh, nhà sinh vật biển, áo lặn màu vàng"],
      locations: ["đại dương sâu"],
      palette: "xanh thẫm và vàng",
      cameraLanguage: "cinematic documentary",
      prohibitedChanges: ["không đổi trang phục của Linh"]
    },
    episodes: Array.from({ length: 10 }, (_, episodeIndex) => ({
      id: `episode-${String(episodeIndex + 1).padStart(2, "0")}`,
      title: `Bí ẩn ${episodeIndex + 1}`,
      hook: `Điều gì đang ẩn dưới vùng nước số ${episodeIndex + 1}?`,
      description: `Một câu chuyện độc lập số ${episodeIndex + 1}.`,
      hashtags: ["#daiduong", "#khampha", "#shorts"],
      scenes: Array.from({ length: 10 }, (_, sceneIndex) => ({
        id: `scene-${String(sceneIndex + 1).padStart(2, "0")}`,
        durationSeconds: 8,
        visual: `Khung cảnh dưới biển ${sceneIndex + 1}`,
        motionPrompt: `Máy quay tiến chậm trong cảnh ${sceneIndex + 1}`,
        narration: `Lời kể ngắn cho cảnh ${sceneIndex + 1}.`,
        caption: `Bí ẩn ${sceneIndex + 1}`
      }))
    }))
  };
}
