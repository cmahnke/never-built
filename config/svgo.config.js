module.exports = {
  multipass: true,
  plugins: [
    "preset-default",
    "removeEditorsNSData",
    {name: "removeAttrs",
      params: { "attrs": "(font-weight|font-size|font-family)" }
    }
  ]
}
