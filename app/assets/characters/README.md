# 小龙娘素材

`dragon-girl-white.png`：透明底白色小龙娘，首页显示高度 96–108 px；录音面板 112 px。由内置 imagegen 生成并按用户要求改为白色主调。项目使用的是本目录内的副本，不依赖 C 盘生成缓存。

生成提示词：

> One original cute chibi dragon girl assistant sprite, full body, compact proportions, friendly expressive eyes, small rounded dragon horns and curled tail, modest cozy outfit, welcoming pose. Soft pastel anime illustration, clear silhouette readable at 96 pixels. Transparent background, no text, scenery, platform or extra characters.

最终修改提示词：

> Preserve character identity, pose, face, silhouette, proportions, outfit shape, wings, horns and tail. Change only the palette to predominantly white: pearly white hair, warm ivory cardigan, white dress with subtle silver-gray trims, white horns, tail and wings with pale silver-gray detailing. Keep pale lavender eyes and natural blush. Remove saturated purple. Keep transparent background; no added objects or text.

动态由 `DragonCompanion.tsx` 实现：轻微漂浮、呼吸、输入回应；离开页面、切后台或减少动态时停止，不是逐帧角色动画。
