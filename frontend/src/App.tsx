import { useState } from 'react'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
      <h1 className="text-4xl font-bold text-blue-600 mb-8">Terraform Homelab</h1>
      <div className="bg-white p-8 rounded-lg shadow-md">
        <p className="text-xl mb-4">Click the button to count:</p>
        <button
          onClick={() => setCount((c) => c + 1)}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
        >
          Count is {count}
        </button>
      </div>
    </div>
  )
}

export default App
